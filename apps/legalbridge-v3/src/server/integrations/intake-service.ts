import { inTransaction, type Transactable } from "../core/db.js";
import { translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { allocateNumber } from "../core/numbering.js";
import { buildAcknowledgement, type IntakeSubmission } from "./slack-intake.js";

/**
 * 受け付けた依頼を案件にする。
 *
 * 依頼者は相手先を正式名称で書かないので、当てはまらなければ紐づけずに
 * 名前だけ残す。ここで新しい取引先を作ると、Slack から打ち込まれた表記
 * ゆれがそのままマスタに増える（V1 の取引先が2,552件まで膨らんだ経路）。
 * 相手先の登録は法務が画面から行う。
 */

export interface IntakeResult {
  matterId: number;
  matterNo: string | null;
  counterpartyId: number | null;
  counterpartyResolved: string | null;
  message: string;
}

export class IntakeService {
  constructor(private readonly database: Transactable) {}

  async accept(submission: IntakeSubmission): Promise<IntakeResult> {
    try {
      return await inTransaction(this.database, async (client) => {
        // 相手先は「はっきり1件に決まる」ときだけ紐づける。
        let counterpartyId: number | null = null;
        let counterpartyResolved: string | null = null;
        if (submission.counterpartyName) {
          const found = await client.query(
            `SELECT pr.resolved_id AS id, pr.resolved_name AS name
               FROM parties p
               JOIN v_party_resolved pr ON pr.party_id = p.id
              WHERE p.status <> 'merged'
                AND (btrim(p.name) = btrim($1)
                     OR EXISTS (SELECT 1 FROM unnest(p.aliases) a WHERE btrim(a) = btrim($1)))
              LIMIT 2`, [submission.counterpartyName]);
          if (found.rows.length === 1) {
            const row = found.rows[0] as any;
            counterpartyId = Number(row.id);
            counterpartyResolved = String(row.name);
          }
        }

        const matterNo = await allocateNumber(
          client, { prefix: "MTR", table: "matters", column: "matter_no" });

        const remarks = [
          submission.detail,
          submission.counterpartyName && !counterpartyId
            ? `依頼時の相手先の記載：${submission.counterpartyName}（未登録）` : null,
          `Slack から受付（${submission.requesterName ?? submission.requesterSlackId}）`
        ].filter(Boolean).join("\n\n");

        const inserted = await client.query(
          `INSERT INTO matters (matter_no, title, kind, status, counterparty_id,
                                requester_slack_id, due_on, remarks, created_by)
           VALUES ($1, $2, $3, 'open', $4, $5, $6, $7, $8)
           RETURNING id, matter_no`,
          [matterNo, submission.title, submission.kind, counterpartyId,
           submission.requesterSlackId || null, submission.dueOn,
           remarks, submission.requesterName ?? submission.requesterSlackId ?? "slack"]);
        const row = inserted.rows[0] as { id: number; matter_no: string | null };
        const matterId = Number(row.id);

        // 相手先が決まらなかったことを課題として残す。放置されないように。
        if (submission.counterpartyName && !counterpartyId) {
          await client.query(
            `INSERT INTO data_quality_issues (rule_code, target_type, target_id, severity, detail)
             VALUES ('INTAKE_PARTY_UNRESOLVED', 'matter', $1, 'medium', $2::jsonb)
             ON CONFLICT (rule_code, target_type, target_id) DO UPDATE SET
               detail = EXCLUDED.detail, detected_at = now(), status = 'open'`,
            [matterId, JSON.stringify({
              written: submission.counterpartyName, matterNo: row.matter_no
            })]);
        }

        await recordAudit(client, {
          actor: submission.requesterName ?? submission.requesterSlackId ?? "slack",
          action: "matter.intake", targetType: "matter", targetId: matterId,
          detail: { source: "slack", kind: submission.kind, matterNo: row.matter_no,
                    counterpartyWritten: submission.counterpartyName,
                    counterpartyResolved }
        });

        return {
          matterId, matterNo: row.matter_no, counterpartyId, counterpartyResolved,
          message: buildAcknowledgement({
            matterNo: row.matter_no, matterId, submission, counterpartyResolved
          })
        };
      });
    } catch (error) { throw translate(error); }
  }
}
