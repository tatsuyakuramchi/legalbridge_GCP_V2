import { inTransaction, type Queryable, type Transactable } from "../core/db.js";
import { translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { allocateNumber } from "../core/numbering.js";
import { buildAcknowledgement, type IntakeSubmission } from "./slack-intake.js";
import type { MatterKind } from "../matters/write-service.js";

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

/**
 * 相手先を名前から引く。「はっきり1件に決まる」ときだけ返す。
 * 受付箱の「新規案件で受付」でも同じ規則を使う。
 */
export async function resolveCounterparty(
  client: Queryable, name: string | null
): Promise<{ id: number; name: string } | null> {
  if (!name) return null;
  const found = await client.query(
    `SELECT pr.resolved_id AS id, pr.resolved_name AS name
               FROM parties p
               JOIN v_party_resolved pr ON pr.party_id = p.id
              WHERE p.status <> 'merged'
                AND (btrim(p.name) = btrim($1)
                     OR EXISTS (SELECT 1 FROM unnest(p.aliases) a WHERE btrim(a) = btrim($1)))
              LIMIT 2`, [name]);
  if (found.rows.length !== 1) return null;
  const row = found.rows[0] as any;
  return { id: Number(row.id), name: String(row.name) };
}

export interface OpenMatterInput {
  title: string;
  kind: MatterKind;
  counterpartyId: number | null;
  /** 取引先に当てはまらなかったときに残す、依頼時の相手先の記載。 */
  counterpartyWritten: string | null;
  ownerStaffId?: number | null;
  requesterSlackId: string | null;
  dueOn: string | null;
  remarks: string;
  createdBy: string;
}

/**
 * 依頼から案件を立てる。相手先が決まらなかったことは課題として残す。
 * Slack の即時受付（IntakeService）と受付箱の受付で共用する。
 */
export async function openMatter(
  client: Queryable, input: OpenMatterInput
): Promise<{ id: number; matterNo: string | null }> {
  const matterNo = await allocateNumber(
    client, { prefix: "MTR", table: "matters", column: "matter_no" });

  const inserted = await client.query(
    `INSERT INTO matters (matter_no, title, kind, status, counterparty_id,
                                requester_slack_id, due_on, remarks, created_by${input.ownerStaffId ? ", owner_staff_id" : ""})
           VALUES ($1, $2, $3, 'open', $4, $5, $6, $7, $8${input.ownerStaffId ? ", $9" : ""})
           RETURNING id, matter_no`,
    [matterNo, input.title, input.kind, input.counterpartyId,
     input.requesterSlackId || null, input.dueOn, input.remarks, input.createdBy,
     ...(input.ownerStaffId ? [input.ownerStaffId] : [])]);
  const row = inserted.rows[0] as { id: number; matter_no: string | null };
  const matterId = Number(row.id);

  // 相手先が決まらなかったことを課題として残す。放置されないように。
  if (input.counterpartyWritten && !input.counterpartyId) {
    await client.query(
      `INSERT INTO data_quality_issues (rule_code, target_type, target_id, severity, detail)
             VALUES ('INTAKE_PARTY_UNRESOLVED', 'matter', $1, 'medium', $2::jsonb)
             ON CONFLICT (rule_code, target_type, target_id) DO UPDATE SET
               detail = EXCLUDED.detail, detected_at = now(), status = 'open'`,
      [matterId, JSON.stringify({
        written: input.counterpartyWritten, matterNo: row.matter_no
      })]);
  }
  return { id: matterId, matterNo: row.matter_no };
}

export class IntakeService {
  constructor(private readonly database: Transactable) {}

  async accept(submission: IntakeSubmission): Promise<IntakeResult> {
    try {
      return await inTransaction(this.database, async (client) => {
        // 相手先は「はっきり1件に決まる」ときだけ紐づける。
        const party = await resolveCounterparty(client, submission.counterpartyName);
        const counterpartyId = party?.id ?? null;
        const counterpartyResolved = party?.name ?? null;

        const remarks = [
          submission.detail,
          submission.counterpartyName && !counterpartyId
            ? `依頼時の相手先の記載：${submission.counterpartyName}（未登録）` : null,
          `Slack から受付（${submission.requesterName ?? submission.requesterSlackId}）`
        ].filter(Boolean).join("\n\n");

        const opened = await openMatter(client, {
          title: submission.title, kind: submission.kind, counterpartyId,
          counterpartyWritten: submission.counterpartyName,
          requesterSlackId: submission.requesterSlackId || null, dueOn: submission.dueOn,
          remarks, createdBy: submission.requesterName ?? submission.requesterSlackId ?? "slack"
        });
        const matterId = opened.id;

        await recordAudit(client, {
          actor: submission.requesterName ?? submission.requesterSlackId ?? "slack",
          action: "matter.intake", targetType: "matter", targetId: matterId,
          detail: { source: "slack", kind: submission.kind, matterNo: opened.matterNo,
                    counterpartyWritten: submission.counterpartyName,
                    counterpartyResolved }
        });

        return {
          matterId, matterNo: opened.matterNo, counterpartyId, counterpartyResolved,
          message: buildAcknowledgement({
            matterNo: opened.matterNo, matterId, submission, counterpartyResolved
          })
        };
      });
    } catch (error) { throw translate(error); }
  }
}
