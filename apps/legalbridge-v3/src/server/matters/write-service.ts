import { inTransaction, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { allocateNumber } from "../core/numbering.js";

export type MatterKind = "work" | "outsourcing" | "single";
export type MatterStatus = "open" | "waiting" | "blocked" | "done" | "canceled";

export interface MatterInput {
  title: string;
  /** フロー種別。必須項目も使えるテンプレートもこれが決める制御列。 */
  kind: MatterKind;
  ownerStaffId?: number | null;
  counterpartyId?: number | null;
  requesterEmail?: string | null;
  dueOn?: string | null;
  remarks?: string | null;
  matterNo?: string | null;
}

export interface TaskInput {
  title: string;
  taskType?: string | null;
  description?: string | null;
  assigneeStaffId?: number | null;
  dueAt?: string | null;
}

const NUMBER = { prefix: "MTR", table: "matters", column: "matter_no" };

export class MatterWriteService {
  constructor(private readonly database: Transactable) {}

  /**
   * 案件の登録。案件は制御レイヤーなので、条件・文書・支払を持たない空の器として作る。
   * 中身は後からぶら下げる。
   */
  async create(input: MatterInput, actor: string): Promise<{ id: number; matterNo: string | null }> {
    const title = String(input.title ?? "").trim();
    if (!title) throw new DomainError("VALIDATION", "案件名は必須です");
    if (!["work", "outsourcing", "single"].includes(input.kind)) {
      throw new DomainError("VALIDATION", "フロー種別は work / outsourcing / single のいずれかです");
    }

    try {
      return await inTransaction(this.database, async (client) => {
        if (input.counterpartyId) {
          const p = await client.query("SELECT id FROM parties WHERE id = $1", [input.counterpartyId]);
          if (!p.rows[0]) {
            throw new DomainError("NOT_FOUND", `取引先 ${input.counterpartyId} が見つかりません`);
          }
        }
        if (input.ownerStaffId) {
          const s = await client.query("SELECT id FROM staff WHERE id = $1", [input.ownerStaffId]);
          if (!s.rows[0]) {
            throw new DomainError("NOT_FOUND", `担当者 ${input.ownerStaffId} が見つかりません`);
          }
        }

        const no = String(input.matterNo ?? "").trim() || await allocateNumber(client, NUMBER);
        const inserted = await client.query(
          `INSERT INTO matters (matter_no, title, kind, status, owner_staff_id, counterparty_id,
                                requester_email, due_on, remarks, created_by)
           VALUES ($1, $2, $3, 'open', $4, $5, $6, $7, $8, $9)
           RETURNING id, matter_no`,
          [no, title, input.kind, input.ownerStaffId ?? null, input.counterpartyId ?? null,
           input.requesterEmail ?? null, input.dueOn ?? null, input.remarks ?? null, actor]);
        const row = inserted.rows[0] as { id: number; matter_no: string | null };
        const id = Number(row.id);

        await recordAudit(client, {
          actor, action: "matter.create", targetType: "matter", targetId: id,
          detail: { title, kind: input.kind, matterNo: row.matter_no,
                    counterpartyId: input.counterpartyId ?? null }
        });
        return { id, matterNo: row.matter_no };
      });
    } catch (error) { throw translate(error); }
  }

  /** 案件の状態変更。blocked にするときは理由が要る（CHECK 制約と同じ規則）。 */
  async changeStatus(
    id: number, status: MatterStatus, actor: string, blockedReason?: string | null
  ) {
    const reason = String(blockedReason ?? "").trim() || null;
    if (status === "blocked" && !reason) {
      throw new DomainError("VALIDATION", "止める理由を書いてください。理由なしでは止められません");
    }
    try {
      return await inTransaction(this.database, async (client) => {
        const before = await client.query("SELECT status FROM matters WHERE id = $1", [id]);
        if (!before.rows[0]) throw new DomainError("NOT_FOUND", `案件 ${id} が見つかりません`);

        await client.query(
          `UPDATE matters SET status = $2,
                  blocked_reason = CASE WHEN $2 = 'blocked' THEN $3 ELSE NULL END,
                  closed_at = CASE WHEN $2 IN ('done','canceled') THEN now() ELSE NULL END,
                  updated_at = now()
            WHERE id = $1`, [id, status, reason]);

        await recordAudit(client, {
          actor, action: "matter.change_status", targetType: "matter", targetId: id,
          detail: { from: (before.rows[0] as { status: string }).status, to: status, reason }
        });
        return { id, status };
      });
    } catch (error) { throw translate(error); }
  }

  async addTask(matterId: number, input: TaskInput, actor: string): Promise<{ id: number }> {
    const title = String(input.title ?? "").trim();
    if (!title) throw new DomainError("VALIDATION", "タスク名は必須です");
    try {
      return await inTransaction(this.database, async (client) => {
        const m = await client.query("SELECT id FROM matters WHERE id = $1", [matterId]);
        if (!m.rows[0]) throw new DomainError("NOT_FOUND", `案件 ${matterId} が見つかりません`);

        const inserted = await client.query(
          `INSERT INTO tasks (matter_id, title, task_type, description, assignee_staff_id, due_at, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'todo') RETURNING id`,
          [matterId, title, input.taskType ?? null, input.description ?? null,
           input.assigneeStaffId ?? null, input.dueAt ?? null]);
        const id = Number((inserted.rows[0] as { id: number }).id);

        await recordAudit(client, {
          actor, action: "matter.add_task", targetType: "matter", targetId: matterId,
          detail: { taskId: id, title, dueAt: input.dueAt ?? null }
        });
        return { id };
      });
    } catch (error) { throw translate(error); }
  }
}
