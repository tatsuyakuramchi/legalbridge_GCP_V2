import { inTransaction, int, str, type Queryable, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import type { DispatchOutcome, DispatchService } from "../integrations/dispatch-service.js";

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

export type Channel = "slack" | "email" | "drive" | "note";
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
  const m = s.match(/\/(?:d|folders|file\/d)\/([A-Za-z0-9_-]{10,})/) ?? s.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
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
    private readonly dispatch: DispatchService
  ) {}

  async list(matterId: number, limit = 200): Promise<Communication[]> {
    try {
      const r = await this.database.query(
        `SELECT c.*, d.document_no
           FROM matter_communications c
           LEFT JOIN documents d ON d.id = c.document_id
          WHERE c.matter_id = $1
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
    input: { channelId?: string | null; threadRef?: string | null; body: string },
    actor: string
  ): Promise<SendResult> {
    const body = String(input.body ?? "").trim();
    if (!body) throw new DomainError("VALIDATION", "送る内容を書いてください");
    try {
      const matter = await this.matter(this.database, matterId);
      const thread = await this.slackThread(this.database, matterId);
      const channelId = str(input.channelId) ?? thread?.channelId ?? matter.requester_slack_id ?? "";
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
          `SELECT name, email, role, department FROM party_contacts
            WHERE party_id = $1 AND email IS NOT NULL ORDER BY role, name`, [matter.counterparty_id])).rows
      : [];
    const party = matter.counterparty_id
      ? (await this.database.query(
          "SELECT name, email FROM parties WHERE id = $1", [matter.counterparty_id])).rows[0] as any
      : null;
    const thread = await this.slackThread(this.database, matterId);
    return {
      owner: owner ? { name: String(owner.name), email: str(owner.email), department: str(owner.department) } : null,
      requesterEmail: str(matter.requester_email),
      counterparty: party ? { name: String(party.name), email: str(party.email) } : null,
      contacts: (contacts as any[]).map((c) => ({
        name: str(c.name), email: String(c.email), role: str(c.role), department: str(c.department)
      })),
      slack: {
        requesterSlackId: str(matter.requester_slack_id),
        channelId: thread?.channelId ?? null, threadTs: thread?.threadTs ?? null
      }
    };
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

  private async slackThread(client: Queryable, matterId: number) {
    const r = await client.query(
      `SELECT target_ref, snapshot FROM matter_links
        WHERE matter_id = $1 AND target_type = 'slack_thread' ORDER BY id LIMIT 1`, [matterId]);
    const row = r.rows[0] as { target_ref: string; snapshot: any } | undefined;
    if (!row) return null;
    const snap = row.snapshot ?? {};
    const [channelId, threadTs] = String(row.target_ref).split(":");
    return {
      channelId: String(snap.channelId ?? channelId ?? ""),
      threadTs: String(snap.threadTs ?? threadTs ?? "")
    };
  }

  private async emailThread(client: Queryable, matterId: number): Promise<string | null> {
    const r = await client.query(
      `SELECT target_ref FROM matter_links
        WHERE matter_id = $1 AND target_type = 'email_thread' ORDER BY id LIMIT 1`, [matterId]);
    const row = r.rows[0] as { target_ref: string } | undefined;
    return row ? String(row.target_ref) : null;
  }
}
