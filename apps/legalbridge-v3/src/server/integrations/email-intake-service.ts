import { inTransaction, type Queryable, type Transactable } from "../core/db.js";
import { translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { allocateNumber } from "../core/numbering.js";
import { describeMail, readMail, type InboundMail, type MailReading } from "./email-intake.js";

/**
 * 受信メールを案件にする。
 *
 * 規則は Slack の受付（intake-service.ts）と揃える。
 *   - 取引先は「はっきり1件に決まる」ときだけ紐づける。新しく作らない。
 *   - 決まらなかったことは課題として残す。放置されないように。
 * メール特有の事情は2つ。
 *   - 同じやり取りが何通も届く。スレッドで寄せて案件を二重に立てない。
 *   - 自動返信・不達通知が混じる。これらは案件にしない。
 *
 * 取り込みの冪等キーはメッセージID。同じメールを二度読んでも案件は増えない。
 */

export type IntakeAction = "created" | "linked" | "duplicate" | "skipped";

export interface MailIntakeResult {
  action: IntakeAction;
  messageId: string;
  matterId: number | null;
  matterNo: string | null;
  counterpartyId: number | null;
  reason?: string;
}

export class EmailIntakeService {
  constructor(private readonly database: Transactable) {}

  async accept(mail: InboundMail): Promise<MailIntakeResult> {
    const reading = readMail(mail);
    const base = { messageId: mail.messageId, matterId: null, matterNo: null, counterpartyId: null };

    if (!mail.messageId) {
      return { ...base, action: "skipped", reason: "メッセージIDが無い" };
    }
    if (reading.machine) {
      // 不在通知のたびに案件が増えるのを防ぐ。監査にも残さない（毎日届く）。
      return { ...base, action: "skipped", reason: "自動返信・不達通知のため取り込まない" };
    }

    try {
      return await inTransaction(this.database, async (client) => {
        const seen = await client.query(
          `SELECT 1 FROM audit_events
            WHERE action IN ('mail.intake', 'mail.link') AND detail->>'messageId' = $1
            LIMIT 1`, [mail.messageId]);
        if (seen.rows[0]) {
          return { ...base, action: "duplicate" as const, reason: "取り込み済み" };
        }

        const existing = await this.findMatter(client, mail, reading);
        if (existing) return await this.link(client, mail, reading, existing);
        return await this.create(client, mail, reading);
      });
    } catch (error) { throw translate(error); }
  }

  /** 既にある案件を探す。スレッド → 案件番号 → 文書番号 の順に確かめる。 */
  private async findMatter(
    client: Queryable, mail: InboundMail, reading: MailReading
  ): Promise<{ id: number; matter_no: string | null } | null> {
    if (mail.threadId) {
      const byThread = await client.query(
        `SELECT m.id, m.matter_no FROM matter_links l JOIN matters m ON m.id = l.matter_id
          WHERE l.target_type = 'email_thread' AND l.target_ref = $1 LIMIT 1`, [mail.threadId]);
      if (byThread.rows[0]) return byThread.rows[0] as any;
    }
    if (reading.matterNo) {
      const byNo = await client.query(
        "SELECT id, matter_no FROM matters WHERE matter_no = $1", [reading.matterNo]);
      if (byNo.rows[0]) return byNo.rows[0] as any;
    }
    if (reading.documentNo) {
      const byDoc = await client.query(
        `SELECT m.id, m.matter_no FROM documents d JOIN matters m ON m.id = d.matter_id
          WHERE d.document_no = $1 LIMIT 1`, [reading.documentNo]);
      if (byDoc.rows[0]) return byDoc.rows[0] as any;
    }
    return null;
  }

  /** 既にある案件へ紐づける。案件の状態も本文も書き換えない。 */
  private async link(
    client: Queryable, mail: InboundMail, reading: MailReading,
    matter: { id: number; matter_no: string | null }
  ): Promise<MailIntakeResult> {
    const matterId = Number(matter.id);
    if (mail.threadId) {
      await client.query(
        `INSERT INTO matter_links (matter_id, target_type, target_ref, relation, snapshot)
         VALUES ($1, 'email_thread', $2, 'correspondence', $3::jsonb)
         ON CONFLICT (matter_id, target_type, target_ref) DO UPDATE SET
           snapshot = matter_links.snapshot || EXCLUDED.snapshot`,
        [matterId, mail.threadId, JSON.stringify({
          lastSubject: mail.subject, lastFrom: reading.sender.email,
          lastReceivedAt: mail.receivedAt,
          attachments: mail.attachments.map((a) => a.filename)
        })]);
    }
    await recordAudit(client, {
      actor: reading.sender.email || "mail",
      action: "mail.link", targetType: "matter", targetId: matterId,
      detail: { messageId: mail.messageId, threadId: mail.threadId,
                subject: mail.subject, matterNo: matter.matter_no,
                attachments: mail.attachments.map((a) => a.filename) }
    });
    return {
      action: "linked", messageId: mail.messageId, matterId,
      matterNo: matter.matter_no ?? null, counterpartyId: null
    };
  }

  /** 新しく案件を立てる。 */
  private async create(
    client: Queryable, mail: InboundMail, reading: MailReading
  ): Promise<MailIntakeResult> {
    const email = reading.sender.email;

    // 社内からの転送なら依頼者。社外なら相手先の候補として見る。
    const staff = email
      ? await client.query("SELECT id, name FROM staff WHERE lower(email) = $1 LIMIT 2", [email])
      : { rows: [] as any[] };
    const internal = staff.rows.length === 1;

    let counterpartyId: number | null = null;
    if (!internal && email) {
      // 連絡先のメールが一致する取引先。2件当たったら決めない。
      const found = await client.query(
        `SELECT DISTINCT pr.resolved_id AS id
           FROM party_contacts pc
           JOIN parties p ON p.id = pc.party_id
           JOIN v_party_resolved pr ON pr.party_id = p.id
          WHERE lower(pc.email) = $1 AND p.status <> 'merged'
          LIMIT 2`, [email]);
      if (found.rows.length === 1) counterpartyId = Number((found.rows[0] as any).id);
    }

    const matterNo = await allocateNumber(
      client, { prefix: "MTR", table: "matters", column: "matter_no" });

    const inserted = await client.query(
      `INSERT INTO matters (matter_no, title, kind, status, counterparty_id,
                            requester_email, remarks, created_by)
       VALUES ($1, $2, $3, 'open', $4, $5, $6, $7)
       RETURNING id, matter_no`,
      [matterNo, reading.title, reading.kind, counterpartyId,
       internal ? email : null, describeMail(mail, reading), email || "mail"]);
    const row = inserted.rows[0] as { id: number; matter_no: string | null };
    const matterId = Number(row.id);

    if (mail.threadId) {
      await client.query(
        `INSERT INTO matter_links (matter_id, target_type, target_ref, relation, snapshot)
         VALUES ($1, 'email_thread', $2, 'origin', $3::jsonb)
         ON CONFLICT (matter_id, target_type, target_ref) DO NOTHING`,
        [matterId, mail.threadId, JSON.stringify({
          firstSubject: mail.subject, firstFrom: email, receivedAt: mail.receivedAt,
          attachments: mail.attachments.map((a) => a.filename)
        })]);
    }

    // 差出人がどこの誰か決まらなかった。人が当てるまで残す。
    if (!internal && !counterpartyId) {
      await client.query(
        `INSERT INTO data_quality_issues (rule_code, target_type, target_id, severity, detail)
         VALUES ('MAIL_SENDER_UNRESOLVED', 'matter', $1, 'medium', $2::jsonb)
         ON CONFLICT (rule_code, target_type, target_id) DO UPDATE SET
           detail = EXCLUDED.detail, detected_at = now(), status = 'open'`,
        [matterId, JSON.stringify({ from: email, subject: mail.subject, matterNo: row.matter_no })]);
    }

    await recordAudit(client, {
      actor: email || "mail",
      action: "mail.intake", targetType: "matter", targetId: matterId,
      detail: { messageId: mail.messageId, threadId: mail.threadId, subject: mail.subject,
                matterNo: row.matter_no, kind: reading.kind, internal,
                counterpartyId, attachments: mail.attachments.map((a) => a.filename) }
    });

    return {
      action: "created", messageId: mail.messageId, matterId,
      matterNo: row.matter_no ?? null, counterpartyId
    };
  }
}
