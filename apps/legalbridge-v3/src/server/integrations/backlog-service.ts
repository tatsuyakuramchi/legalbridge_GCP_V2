import { inTransaction, type Queryable, type Transactable } from "../core/db.js";
import { dateStr } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import type { DispatchService } from "./dispatch-service.js";
import type { GateResult } from "./gate.js";

/**
 * 案件から Backlog の課題を立てる。
 *
 * 受信側（inbound-handlers.ts）は matter_links の 'backlog_issue' を辿って
 * 案件を特定する。その紐づけを作るのがここ。作る口が無いと、受信しても
 * 永久に「紐づく案件が無い」で終わる。
 *
 * 1つの案件に課題は1つ。二度押しても増やさない。増やすと、同じ案件の
 * やり取りが2つの課題に分かれて、どちらが本流か分からなくなる。
 *
 * 送信はゲートを通す。off なら課題は立たず、何を送るはずだったかだけが
 * 残る。dry_run なら中身を返して紐づけは作らない（立っていない課題の
 * キーを控えると、受信のたびに存在しない課題を指すことになる）。
 */

export interface BacklogIssueResult {
  matterId: number;
  matterNo: string | null;
  /** 課題キー。立っていなければ null。 */
  issueKey: string | null;
  url: string | null;
  /** この操作で課題が立ったか。 */
  created: boolean;
  gate?: GateResult;
  preview?: { subject: string | null; bodyPreview: string };
  reason?: string;
}

const KIND_LABEL: Record<string, string> = {
  work: "作品の権利", outsourcing: "業務委託・発注", single: "その他の相談"
};

/** 課題の件名。案件番号を頭に置く。Backlog 側で検索できるようにするため。 */
export function issueSummary(matter: {
  matter_no: string | null; title: string;
}): string {
  const no = matter.matter_no ? `[${matter.matter_no}] ` : "";
  return `${no}${matter.title}`.slice(0, 255);
}

/** 課題の本文。Backlog だけを見ている人が状況を掴めるだけの情報を入れる。 */
export function issueDescription(matter: Record<string, any>, note?: string | null): string {
  const lines = [
    `案件番号：${matter.matter_no ?? `#${matter.id}`}`,
    `種別：${KIND_LABEL[String(matter.kind)] ?? matter.kind}`,
    `相手先：${matter.party_name ?? "（未特定）"}`,
    `期日：${dateStr(matter.due_on) ?? "（未設定）"}`,
    `法務担当：${matter.owner_name ?? "（未割当）"}`
  ];
  if (note?.trim()) lines.push("", note.trim());
  if (matter.remarks) lines.push("", "---", String(matter.remarks).slice(0, 2000));
  lines.push("", "※ LegalBridge の案件から作成。状態は Backlog で進めてください。");
  return lines.join("\n");
}

export class BacklogService {
  constructor(
    private readonly database: Transactable,
    private readonly dispatch: DispatchService,
    private readonly options: { host: string; issueTypeId: string }
  ) {}

  private url(issueKey: string | null): string | null {
    return issueKey && this.options.host ? `https://${this.options.host}/view/${issueKey}` : null;
  }

  /** すでに紐づいている課題。 */
  private async existing(client: Queryable, matterId: number): Promise<string | null> {
    const r = await client.query(
      `SELECT target_ref FROM matter_links
        WHERE matter_id = $1 AND target_type = 'backlog_issue' ORDER BY id LIMIT 1`, [matterId]);
    const row = r.rows[0] as { target_ref?: string } | undefined;
    return row?.target_ref ? String(row.target_ref) : null;
  }

  /**
   * 課題キーを案件に繋ぐ。
   *
   * 同じ課題キーを2つの案件に繋がせない。繋げてしまうと、受信したとき
   * どちらの案件の話か決まらず、片方が黙って無視される。
   */
  private async attach(
    client: Queryable, matterId: number, issueKey: string, actor: string,
    snapshot: Record<string, unknown>
  ): Promise<void> {
    const other = await client.query(
      `SELECT matter_id, m.matter_no FROM matter_links l JOIN matters m ON m.id = l.matter_id
        WHERE l.target_type = 'backlog_issue' AND l.target_ref = $1 AND l.matter_id <> $2
        LIMIT 1`, [issueKey, matterId]);
    const row = other.rows[0] as any;
    if (row) {
      throw new DomainError("CONFLICT",
        `課題 ${issueKey} は案件 ${row.matter_no ?? row.matter_id} に繋がっています。` +
        "先にそちらの紐づけを外してください");
    }
    await client.query(
      `INSERT INTO matter_links (matter_id, target_type, target_ref, relation, snapshot)
       VALUES ($1, 'backlog_issue', $2, 'tracking', $3::jsonb)
       ON CONFLICT (matter_id, target_type, target_ref) DO NOTHING`,
      [matterId, issueKey, JSON.stringify(snapshot)]);
    await recordAudit(client, {
      actor, action: "matter.backlog_issue", targetType: "matter", targetId: matterId,
      detail: { issueKey, ...snapshot }
    });
  }

  /**
   * Backlog に既にある課題を案件に繋ぐ。
   *
   * 移行前から Backlog で進めている案件は、こちらから課題を立てる余地が
   * ない。繋ぐ口が無いと、その案件だけ受信が永久に届かない。
   */
  async link(matterId: number, issueKey: string, actor: string): Promise<BacklogIssueResult> {
    const key = String(issueKey ?? "").trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) {
      throw new DomainError("VALIDATION",
        `課題キーの形が違います（例：LEGAL-12）：${issueKey}`);
    }
    try {
      return await inTransaction(this.database, async (client) => {
        const head = await client.query(
          "SELECT id, matter_no FROM matters WHERE id = $1", [matterId]);
        const matter = head.rows[0] as any;
        if (!matter) throw new DomainError("NOT_FOUND", `案件 ${matterId} が見つかりません`);

        const already = await this.existing(client, matterId);
        if (already && already !== key) {
          throw new DomainError("CONFLICT",
            `この案件は課題 ${already} に繋がっています。先に外してください`);
        }
        await this.attach(client, matterId, key, actor, {
          linkedBy: actor, linkedAt: new Date().toISOString()
        });
        return {
          matterId, matterNo: matter.matter_no ?? null, issueKey: key,
          url: this.url(key), created: false,
          reason: already === key ? "すでに繋がっています" : "既存の課題に繋ぎました"
        };
      });
    } catch (error) { throw translate(error); }
  }

  async createIssue(
    matterId: number, actor: string, options: { note?: string | null } = {}
  ): Promise<BacklogIssueResult> {
    try {
      const head = await this.database.query(
        `SELECT m.id, m.matter_no, m.title, m.kind, m.status, m.due_on, m.remarks,
                p.name AS party_name, s.name AS owner_name
           FROM matters m
           LEFT JOIN parties p ON p.id = m.counterparty_id
           LEFT JOIN staff   s ON s.id = m.owner_staff_id
          WHERE m.id = $1`, [matterId]);
      const matter = head.rows[0] as Record<string, any> | undefined;
      if (!matter) throw new DomainError("NOT_FOUND", `案件 ${matterId} が見つかりません`);

      const already = await this.existing(this.database, matterId);
      if (already) {
        // 二度押しても増やさない。既にあるものを返す。
        return {
          matterId, matterNo: matter.matter_no ?? null, issueKey: already,
          url: this.url(already), created: false,
          reason: "この案件にはすでに Backlog の課題があります"
        };
      }

      const subject = issueSummary(matter as any);
      const body = issueDescription(matter, options.note);
      const outcome = await this.dispatch.dispatch({
        channel: "backlog", targetType: "matter", targetId: matterId, actor,
        request: { recipient: this.options.issueTypeId, subject, body }
      });

      if (!outcome.sent) {
        // 同じ内容で既に送ってあるなら、課題は Backlog に在る。紐づけだけ
        // 失っている状態なので繋ぎ直す（外したあと繋げないと行き止まりになる）。
        if (outcome.duplicated && outcome.externalId) {
          const key = String(outcome.externalId);
          await inTransaction(this.database, (client) =>
            this.attach(client, matterId, key, actor, { recovered: true, summary: subject }));
          return {
            matterId, matterNo: matter.matter_no ?? null, issueKey: key,
            url: this.url(key), created: false, gate: outcome.gate,
            reason: "同じ内容で立てた課題が既にあります。その課題に繋ぎ直しました"
          };
        }
        // 立っていない課題のキーは控えない。受信のたびに存在しない課題を指す。
        return {
          matterId, matterNo: matter.matter_no ?? null, issueKey: null, url: null,
          created: false, gate: outcome.gate,
          ...(outcome.preview ? { preview: { subject, bodyPreview: outcome.preview.bodyPreview } } : {}),
          reason: outcome.duplicated
            ? "同じ内容が直前に送られていますが、課題キーが分かりません"
            : outcome.gate.reasons.join(" / ")
        };
      }

      const issueKey = String(outcome.externalId ?? "").trim();
      if (!issueKey) {
        // 送れたのにキーが返らない。紐づけないと受信で辿れないので課題として残す。
        return {
          matterId, matterNo: matter.matter_no ?? null, issueKey: null, url: null,
          created: true, gate: outcome.gate,
          reason: "課題は立ちましたが課題キーを受け取れませんでした。Backlog 側で確認してください"
        };
      }

      await inTransaction(this.database, (client) =>
        this.attach(client, matterId, issueKey, actor, {
          summary: subject, createdBy: actor, createdAt: new Date().toISOString()
        }));

      return {
        matterId, matterNo: matter.matter_no ?? null, issueKey,
        url: this.url(issueKey), created: true, gate: outcome.gate
      };
    } catch (error) { throw translate(error); }
  }

  /**
   * 紐づけを外す。課題そのものは消さない（Backlog 側の記録は残す）。
   * 間違った課題に繋いだときの直し方がないと、受信が別の案件を動かし続ける。
   */
  async unlink(matterId: number, issueKey: string, actor: string): Promise<{ removed: boolean }> {
    try {
      return await inTransaction(this.database, async (client) => {
        const r = await client.query(
          `DELETE FROM matter_links
            WHERE matter_id = $1 AND target_type = 'backlog_issue' AND target_ref = $2`,
          [matterId, issueKey]);
        const removed = (r.rowCount ?? 0) > 0;
        if (removed) {
          await recordAudit(client, {
            actor, action: "matter.backlog_unlink", targetType: "matter", targetId: matterId,
            detail: { issueKey }
          });
        }
        return { removed };
      });
    } catch (error) { throw translate(error); }
  }
}
