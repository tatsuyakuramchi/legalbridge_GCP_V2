import { inTransaction, int, str, type Queryable, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import type { DispatchOutcome, DispatchService } from "../integrations/dispatch-service.js";
import { LEGAL_CONSULT_KEY, readLegalConsultSettings, withMentions } from "../ops/legal-consult-settings.js";

/**
 * 案件のやり取り。担当者との Slack、メールの送受信、ファイルの受け渡し、メモ。
 *
 * これまで送信は audit_events に、受信メールは matter_links の snapshot に、
 * Slack の受信はどこにも残っていなかった。1本の表（matter_communications）に
 * まとめ、証憑として本文と生の記録（evidence）を持つ。追記だけ。
 *
 * 送信は DispatchService を通す（ゲート・冪等・監査はそちら）。ここは
 * 「送った／受け取った」を案件の時系列として残す側。
 */

export type Channel = "slack" | "email" | "cloudsign" | "drive" | "note";
export type Direction = "in" | "out" | "note";

export interface Communication {
  id: number;
  matterId: number;
  channel: Channel;
  direction: Direction;
  occurredAt: string;
  actor: string;
  counterpart: string | null;
  subject: string | null;
  body: string | null;
  externalRef: string | null;
  externalUrl: string | null;
  documentId: number | null;
  documentNo: string | null;
  evidence: Record<string, unknown>;
}

export interface InboundRecord {
  matterId: number;
  channel: Channel;
  direction: Direction;
  occurredAt?: string | null;
  actor: string;
  counterpart?: string | null;
  subject?: string | null;
  body?: string | null;
  externalRef?: string | null;
  externalUrl?: string | null;
  documentId?: number | null;
  evidence?: Record<string, unknown>;
}

/**
 * 1件書く。外部側の ID が同じものは二度書かない（webhook の再送・
 * 取り込みの再実行で増えない）。書けなかったら null。
 */
export async function recordCommunication(
  client: Queryable, input: InboundRecord
): Promise<number | null> {
  const r = await client.query(
    `INSERT INTO matter_communications
       (matter_id, channel, direction, occurred_at, actor, counterpart, subject, body,
        external_ref, external_url, document_id, evidence)
     VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()), $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
     ON CONFLICT (channel, external_ref) WHERE external_ref IS NOT NULL DO NOTHING
     RETURNING id`,
    [input.matterId, input.channel, input.direction, input.occurredAt ?? null,
     input.actor, input.counterpart ?? null, input.subject ?? null, input.body ?? null,
     input.externalRef ?? null, input.externalUrl ?? null, input.documentId ?? null,
     JSON.stringify(input.evidence ?? {})]);
  const row = r.rows[0] as { id: number } | undefined;
  return row ? Number(row.id) : null;
}

/** Drive の URL からファイル／フォルダの ID を取り出す。取れなければ null。 */
export function driveIdFromUrl(url: string): string | null {
  const s = String(url ?? "").trim();
  const m = s.match(/\/(?:d|folders|file\/d)\/([A-Za-z0-9_-]{10,})/) ?? s.match(/[?&]id=([A-Za-z0-9_-]{10,})/)
    // 予備系・開発用のローカル保存のリンク。
    ?? s.match(/\/local-files\/([A-Za-z0-9][A-Za-z0-9._-]{0,120})(?:[?#]|$)/);
  return m ? m[1] : null;
}

/** Slack のメッセージを一意に呼ぶ。ts はチャンネルの中でしか一意でない。 */
export const slackRef = (channel: string, ts: string) => `${channel}:${ts}`;

const map = (row: Record<string, any>): Communication => ({
  id: Number(row.id),
  matterId: Number(row.matter_id),
  channel: String(row.channel) as Channel,
  direction: String(row.direction) as Direction,
  occurredAt: new Date(String(row.occurred_at)).toISOString(),
  actor: String(row.actor),
  counterpart: str(row.counterpart),
  subject: str(row.subject),
  body: str(row.body),
  externalRef: str(row.external_ref),
  externalUrl: str(row.external_url),
  documentId: int(row.document_id),
  documentNo: str(row.document_no),
  evidence: (row.evidence as Record<string, unknown>) ?? {}
});

export interface SendResult {
  outcome: DispatchOutcome;
  /** 送れたときだけ。ゲートで止まったら null（記録するものが無い）。 */
  communication: Communication | null;
}

export class MatterCommunicationService {
  constructor(
    private readonly database: Transactable,
    private readonly dispatch: DispatchService,
    /** 相談窓口のスレッドの根に載せるこのサービスの URL（無ければ載せない）。 */
    private readonly options: { publicBaseUrl?: string } = {}
  ) {}

  async list(matterId: number, limit = 200): Promise<Communication[]> {
    try {
      const r = await this.database.query(
        `SELECT c.*, d.document_no
           FROM matter_communications c
           LEFT JOIN documents d ON d.id = c.document_id
          -- 統合した案件（merged_into_id）のやり取りも一緒に読む。記録は追記専用で
          -- 統合のときに付け替えないので、読む側で束ねる。
          WHERE c.matter_id IN (SELECT m.id FROM matters m WHERE m.id = $1 OR m.merged_into_id = $1)
          ORDER BY c.occurred_at DESC, c.id DESC
          LIMIT $2`, [matterId, Math.min(Math.max(limit, 1), 500)]);
      return r.rows.map(map);
    } catch (error) { throw translate(error); }
  }

  async find(id: number, client: Queryable = this.database): Promise<Communication | null> {
    // トランザクションの中で書いた行は、同じ client でしか見えない。
    const r = await client.query(
      `SELECT c.*, d.document_no FROM matter_communications c
         LEFT JOIN documents d ON d.id = c.document_id WHERE c.id = $1`, [id]);
    const row = r.rows[0] as Record<string, any> | undefined;
    return row ? map(row) : null;
  }

  /** 送受信の外で起きたこと（電話・口頭・打合せ）を残す。 */
  async note(matterId: number, input: { body: string }, actor: string): Promise<Communication> {
    const body = String(input.body ?? "").trim();
    if (!body) throw new DomainError("VALIDATION", "メモの内容を書いてください");
    try {
      return await inTransaction(this.database, async (client) => {
        await this.assertMatter(client, matterId);
        const id = await recordCommunication(client, {
          matterId, channel: "note", direction: "note", actor, body
        });
        return (await this.find(id!, client))!;
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 担当者へ Slack で送る。
   *
   * 宛先は 指定 → 案件のスレッド → 依頼者の DM の順に決める。案件にスレッドが
   * まだ無ければ、送った最初のメッセージをスレッドの根にして控える。以後の
   * 送信はその下に付き、返信（webhook）もその根で案件に辿り着く。
   */
  async sendSlack(
    matterId: number,
    input: {
      channelId?: string | null; threadRef?: string | null; body: string;
      /** direct＝依頼者（既定）／consult＝法務相談窓口のチャンネルのスレッド。 */
      target?: "direct" | "consult";
      /** 本文の頭に付けるメンション（U…）。 */
      mentions?: string[] | null;
    },
    actor: string
  ): Promise<SendResult> {
    const text = String(input.body ?? "").trim();
    if (!text) throw new DomainError("VALIDATION", "送る内容を書いてください");
    const body = withMentions(text, input.mentions);
    if (input.target === "consult") return this.sendConsult(matterId, body, actor);
    try {
      const matter = await this.matter(this.database, matterId);
      const thread = await this.slackThread(this.database, matterId, "direct");
      const channelId = str(input.channelId) ?? thread?.channelId ?? matter.requester_slack_id
        ?? (await this.slackOfEmail(this.database, str(matter.requester_email)))?.slackId ?? "";
      const threadRef = str(input.threadRef)
        ?? (thread && thread.channelId === channelId ? thread.threadTs : null);

      const outcome = await this.dispatch.dispatch({
        channel: "slack", targetType: "matter", targetId: matterId, actor,
        request: { recipient: channelId, body, threadRef }
      });
      if (!outcome.sent) return { outcome, communication: null };

      const ts = String(outcome.externalId ?? "");
      return await inTransaction(this.database, async (client) => {
        if (!thread && ts) {
          // 最初の1通をスレッドの根にする。返信はここに付く。
          await client.query(
            `INSERT INTO matter_links (matter_id, target_type, target_ref, relation, snapshot)
             VALUES ($1, 'slack_thread', $2, 'correspondence', $3::jsonb)
             ON CONFLICT (matter_id, target_type, target_ref) DO NOTHING`,
            [matterId, slackRef(channelId, ts),
             JSON.stringify({ channelId, threadTs: ts, startedBy: actor })]);
        }
        const id = await recordCommunication(client, {
          matterId, channel: "slack", direction: "out", actor,
          counterpart: channelId, body,
          externalRef: ts ? slackRef(channelId, ts) : null,
          evidence: { channelId, ts, threadRef: threadRef ?? ts, receipt: outcome.externalId }
        });
        return { outcome, communication: id ? await this.find(id, client) : null };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 法務相談窓口（設定の legal_consult のチャンネル）へ送る。
   *
   * 案件ごとに 1 本のスレッド。まだ無ければ、案件番号・件名・相手先を書いた
   * 親メッセージを先に投稿してスレッドを立て、本文はその下に返信する。
   * 窓口のチャンネルを設定で変えたら、次の 1 通から新しいチャンネルにスレッドを立てる。
   * 窓口のスレッドへの返信は、ほかのスレッドと同じく受信（webhook）で案件に入る。
   */
  private async sendConsult(matterId: number, body: string, actor: string): Promise<SendResult> {
    try {
      const channelId = (await this.consultSettings(this.database)).channelId;
      if (!channelId) {
        throw new DomainError("VALIDATION",
          "法務相談窓口のチャンネルが未設定です。運用 → 設定 の「法務相談窓口（Slack）」でチャンネル ID を入れてください");
      }
      const matter = await this.matter(this.database, matterId);
      let thread = await this.slackThread(this.database, matterId, "consult");
      if (thread && thread.channelId !== channelId) thread = null;

      if (!thread) {
        const root = await this.consultRootText(matter);
        const opened = await this.dispatch.dispatch({
          channel: "slack", targetType: "matter", targetId: matterId, actor,
          request: { recipient: channelId, body: root, threadRef: null }
        });
        const rootTs = String(opened.externalId ?? "");
        if (!opened.sent || !rootTs) return { outcome: opened, communication: null };
        await inTransaction(this.database, async (client) => {
          await client.query(
            `INSERT INTO matter_links (matter_id, target_type, target_ref, relation, snapshot)
             VALUES ($1, 'slack_thread', $2, 'correspondence', $3::jsonb)
             ON CONFLICT (matter_id, target_type, target_ref) DO NOTHING`,
            [matterId, slackRef(channelId, rootTs),
             JSON.stringify({ channelId, threadTs: rootTs, startedBy: actor, kind: "consult" })]);
          await recordCommunication(client, {
            matterId, channel: "slack", direction: "out", actor, counterpart: channelId, body: root,
            externalRef: slackRef(channelId, rootTs),
            evidence: { channelId, ts: rootTs, threadRef: rootTs, kind: "consult", root: true }
          });
          await recordAudit(client, {
            actor, action: "matter.consult_thread", targetType: "matter", targetId: matterId,
            detail: { channelId, threadTs: rootTs }
          });
        });
        thread = { channelId, threadTs: rootTs };
      }

      const outcome = await this.dispatch.dispatch({
        channel: "slack", targetType: "matter", targetId: matterId, actor,
        request: { recipient: channelId, body, threadRef: thread.threadTs }
      });
      if (!outcome.sent) return { outcome, communication: null };
      const ts = String(outcome.externalId ?? "");
      return await inTransaction(this.database, async (client) => {
        const id = await recordCommunication(client, {
          matterId, channel: "slack", direction: "out", actor, counterpart: channelId, body,
          externalRef: ts ? slackRef(channelId, ts) : null,
          evidence: { channelId, ts, threadRef: thread!.threadTs, kind: "consult", receipt: outcome.externalId }
        });
        return { outcome, communication: id ? await this.find(id, client) : null };
      });
    } catch (error) { throw translate(error); }
  }

  private async consultSettings(client: Queryable) {
    const r = await client.query("SELECT value FROM settings WHERE key = $1", [LEGAL_CONSULT_KEY]);
    return readLegalConsultSettings((r.rows[0] as any)?.value);
  }

  /** 窓口のスレッドの親。何の相談かが Slack だけで分かるように。 */
  private async consultRootText(matter: Record<string, any>): Promise<string> {
    const party = matter.counterparty_id
      ? ((await this.database.query("SELECT name FROM parties WHERE id = $1", [matter.counterparty_id])).rows[0] as any)?.name
      : null;
    const owner = matter.owner_staff_id
      ? ((await this.database.query("SELECT name FROM staff WHERE id = $1", [matter.owner_staff_id])).rows[0] as any)?.name
      : null;
    const base = String(this.options.publicBaseUrl ?? "").replace(/\/+$/, "");
    return [
      `📁 *法務相談* ${str(matter.matter_no) ?? `案件 ${matter.id}`} ${str(matter.title) ?? ""}`.trim(),
      party ? `*相手先:* ${party}` : null,
      owner ? `*法務担当:* ${owner}` : null,
      base ? `*LegalBridge:* ${base}` : null,
      `_この案件のやり取りはこのスレッドで続けます（${new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " ")} 立て）_`
    ].filter(Boolean).join("\n");
  }

  /**
   * メールで送る。担当者だけ（to 担当者）か、取引先へ担当者を写しに入れて
   * （to 取引先 cc 担当者）。どちらにするかは呼ぶ側が宛先で決める。
   * 案件にスレッドがあればそこへ続ける（返信が同じ案件に戻ってくる）。
   */
  async sendEmail(
    matterId: number,
    input: {
      to: string[]; cc?: string[]; subject: string; body: string;
      documentId?: number | null;
      attachment?: { filename: string; mimeType: string; data: Buffer } | null;
    },
    actor: string
  ): Promise<SendResult> {
    const to = (input.to ?? []).map((v) => String(v).trim()).filter(Boolean);
    const cc = (input.cc ?? []).map((v) => String(v).trim()).filter(Boolean)
      .filter((v) => !to.includes(v));
    if (!to.length) throw new DomainError("VALIDATION", "宛先（to）を入れてください");
    const subject = String(input.subject ?? "").trim();
    const body = String(input.body ?? "").trim();
    if (!subject) throw new DomainError("VALIDATION", "件名を入れてください");
    if (!body) throw new DomainError("VALIDATION", "本文を書いてください");
    try {
      await this.matter(this.database, matterId);
      const thread = await this.emailThread(this.database, matterId);
      const outcome = await this.dispatch.dispatch({
        channel: "gmail", targetType: input.documentId ? "document" : "matter",
        targetId: input.documentId ?? matterId, actor,
        request: { recipient: to.join(", "), cc, subject, body,
                   attachment: input.attachment ?? null, threadRef: thread }
      });
      if (!outcome.sent) return { outcome, communication: null };

      return await inTransaction(this.database, async (client) => {
        const threadId = str(outcome.threadRef);
        if (!thread && threadId) {
          await client.query(
            `INSERT INTO matter_links (matter_id, target_type, target_ref, relation, snapshot)
             VALUES ($1, 'email_thread', $2, 'correspondence', $3::jsonb)
             ON CONFLICT (matter_id, target_type, target_ref) DO NOTHING`,
            [matterId, threadId, JSON.stringify({ firstSubject: subject, startedBy: actor })]);
        }
        const id = await recordCommunication(client, {
          matterId, channel: "email", direction: "out", actor,
          counterpart: [...to, ...cc.map((c) => `cc:${c}`)].join(", "),
          subject, body,
          externalRef: str(outcome.externalId),
          documentId: input.documentId ?? null,
          evidence: { to, cc, threadId, attachment: input.attachment?.filename ?? null,
                      messageId: outcome.externalId ?? null }
        });
        return { outcome, communication: id ? await this.find(id, client) : null };
      });
    } catch (error) { throw translate(error); }
  }

  /** Drive のファイルを「受け取った／渡した」として残す。中身はコピーしない。リンクだけ。 */
  async linkDrive(
    matterId: number,
    input: { url: string; title?: string | null; direction: "in" | "out"; note?: string | null },
    actor: string
  ): Promise<Communication> {
    const url = String(input.url ?? "").trim();
    const fileId = driveIdFromUrl(url);
    if (!fileId) {
      throw new DomainError("VALIDATION",
        "Drive のリンクとして読めません。ファイルかフォルダの共有リンクを貼ってください");
    }
    try {
      return await inTransaction(this.database, async (client) => {
        await this.assertMatter(client, matterId);
        const id = await recordCommunication(client, {
          matterId, channel: "drive", direction: input.direction, actor,
          subject: str(input.title), body: str(input.note),
          externalRef: fileId, externalUrl: url,
          evidence: { fileId, url }
        });
        if (!id) {
          throw new DomainError("CONFLICT",
            "このファイルはもう記録されています（同じリンクを二度は残しません）");
        }
        await recordAudit(client, {
          actor, action: "matter.drive_link", targetType: "matter", targetId: matterId,
          detail: { fileId, direction: input.direction, title: input.title ?? null }
        });
        return (await this.find(id, client))!;
      });
    } catch (error) { throw translate(error); }
  }

  /** 送る相手の候補。担当者（自社）と取引先の連絡先、Slack の宛先。 */
  async recipients(matterId: number) {
    const matter = await this.matter(this.database, matterId);
    const owner = matter.owner_staff_id
      ? (await this.database.query(
          "SELECT name, email, department FROM staff WHERE id = $1", [matter.owner_staff_id])).rows[0] as any
      : null;
    const contacts = matter.counterparty_id
      ? (await this.database.query(
          `SELECT name, email, array_to_string(roles, ',') AS role, department FROM party_contacts
            WHERE party_id = $1 AND email IS NOT NULL ORDER BY id`, [matter.counterparty_id])).rows
      : [];
    const party = matter.counterparty_id
      ? (await this.database.query(
          "SELECT name, email FROM parties WHERE id = $1", [matter.counterparty_id])).rows[0] as any
      : null;
    const thread = await this.slackThread(this.database, matterId, "direct");
    const consult = await this.consultSettings(this.database);
    const consultThread = await this.slackThread(this.database, matterId, "consult");
    return {
      owner: owner ? { name: String(owner.name), email: str(owner.email), department: str(owner.department) } : null,
      requesterEmail: str(matter.requester_email),
      counterparty: party ? { name: String(party.name), email: str(party.email) } : null,
      contacts: (contacts as any[]).map((c) => ({
        name: str(c.name), email: String(c.email), role: str(c.role), department: str(c.department)
      })),
      slack: {
        requesterSlackId: str(matter.requester_slack_id),
        channelId: thread?.channelId ?? null, threadTs: thread?.threadTs ?? null,
        // 宛先が無いとき、依頼者のメールから社員を引いてその Slack ID へ送る。
        fromRequesterEmail: str(matter.requester_slack_id) ? null : await this.slackOfEmail(this.database, str(matter.requester_email)),
        // 法務相談窓口。チャンネルが未設定なら channelId は null。スレッドは今の窓口のものだけ。
        consult: {
          channelId: consult.channelId || null,
          label: consult.label || null,
          threadTs: consultThread && consultThread.channelId === consult.channelId ? consultThread.threadTs : null
        }
      }
    };
  }

  /** メールから社員を引き、その Slack ID。1人に決まらなければ null。 */
  private async slackOfEmail(client: Queryable, email: string | null): Promise<{ slackId: string; name: string } | null> {
    if (!email) return null;
    const r = await client.query(
      `SELECT name, slack_user_id FROM staff
        WHERE lower(email) = lower($1) AND slack_user_id IS NOT NULL AND slack_user_id <> '' LIMIT 2`, [email]);
    return r.rows.length === 1
      ? { slackId: String((r.rows[0] as any).slack_user_id), name: String((r.rows[0] as any).name) } : null;
  }

  /**
   * 案件の Slack の宛先を決める（依頼者の Slack ID の欄に持つ）。Slack の依頼から立てた
   * 案件でないと入らないので、画面から入れられるようにする。人（U…）でもチャンネル（C…）でもよい。
   * 宛先を変えたら、前の宛先で始めたスレッドの控えは外す（次の1通が新しいスレッドの根になる）。
   * やり取りの記録は残る。
   */
  async setSlackRecipient(matterId: number, slackId: string | null, actor: string): Promise<{ slackId: string | null }> {
    const next = slackId ? slackId.trim().toUpperCase() : null;
    if (next && !/^[UWCG][A-Z0-9]{6,}$/.test(next)) {
      throw new DomainError("VALIDATION", "Slack の ID は U（人）か C（チャンネル）から始まる英数字です");
    }
    try {
      return await inTransaction(this.database, async (client) => {
        const before = await this.matter(client, matterId);
        await client.query("UPDATE matters SET requester_slack_id = $2, updated_at = now() WHERE id = $1", [matterId, next]);
        const thread = await this.slackThread(client, matterId, "direct");
        if (thread && thread.channelId !== next) {
          // 相談窓口のスレッドは宛先と関係ないので残す。
          await client.query(
            `DELETE FROM matter_links WHERE matter_id = $1 AND target_type = 'slack_thread'
               AND COALESCE(snapshot->>'kind', 'direct') <> 'consult'`, [matterId]);
        }
        await recordAudit(client, {
          actor, action: "matter.slack_recipient", targetType: "matter", targetId: matterId,
          detail: { before: str(before.requester_slack_id), after: next, threadReset: Boolean(thread && thread.channelId !== next) }
        });
        return { slackId: next };
      });
    } catch (error) { throw translate(error); }
  }

  private async matter(client: Queryable, id: number) {
    const r = await client.query(
      `SELECT id, matter_no, title, owner_staff_id, counterparty_id, requester_email, requester_slack_id
         FROM matters WHERE id = $1`, [id]);
    const row = r.rows[0] as Record<string, any> | undefined;
    if (!row) throw new DomainError("NOT_FOUND", `案件 ${id} が見つかりません`);
    return row;
  }
  private async assertMatter(client: Queryable, id: number) { await this.matter(client, id); }

  /**
   * 案件の Slack のスレッド。direct＝依頼者とのスレッド、consult＝法務相談窓口の
   * スレッド（snapshot の kind）。kind の無い古い控えは direct。
   */
  private async slackThread(client: Queryable, matterId: number, kind: "direct" | "consult") {
    const r = await client.query(
      `SELECT target_ref, snapshot FROM matter_links
        WHERE matter_id = $1 AND target_type = 'slack_thread'
          AND (COALESCE(snapshot->>'kind', 'direct') = 'consult') = $2
        ORDER BY id ${kind === "consult" ? "DESC" : "ASC"} LIMIT 1`, [matterId, kind === "consult"]);
    const row = r.rows[0] as { target_ref: string; snapshot: any } | undefined;
    if (!row) return null;
    const snap = row.snapshot ?? {};
    const [channelId, threadTs] = String(row.target_ref).split(":");
    return {
      channelId: String(snap.channelId ?? channelId ?? ""),
      threadTs: String(snap.threadTs ?? threadTs ?? "")
    };
  }

  /** その案件のメールのスレッド。何枚かまとめて送るときも同じ流れに続ける。 */
  async emailThreadOf(matterId: number): Promise<string | null> {
    return this.emailThread(this.database, matterId);
  }

  private async emailThread(client: Queryable, matterId: number): Promise<string | null> {
    const r = await client.query(
      `SELECT target_ref FROM matter_links
        WHERE matter_id = $1 AND target_type = 'email_thread' ORDER BY id LIMIT 1`, [matterId]);
    const row = r.rows[0] as { target_ref: string } | undefined;
    return row ? String(row.target_ref) : null;
  }
}
