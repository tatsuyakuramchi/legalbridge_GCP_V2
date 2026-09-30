import { dateStr, inTransaction, type Queryable, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { openMatter, resolveCounterparty } from "../integrations/intake-service.js";
import { connectRequestToMatter } from "../intake/request-service.js";
import type { MatterKind } from "../matters/write-service.js";

/**
 * 作業テーブル（tasks）の書き込み。docs/v3-request-inbox.md §10（A-064）
 *
 * 案件の中の作業もデイリータスクも同じ表なので、状態・担当・期日の変更は 1 つの経路。
 * デイリータスクだけにあるのが「案件に移す」（思ったより大きかった）。行は同じまま
 * matter_id を埋め、元の依頼を案件へ繋ぎ直す。
 */

export type TaskStatus = "todo" | "doing" | "blocked" | "done";
export const TASK_STATUSES: TaskStatus[] = ["todo", "doing", "blocked", "done"];

export interface TaskPatch {
  status?: TaskStatus;
  title?: string | null;
  assigneeStaffId?: number | null;
  /** 期日（日本の日付）。null で消す。undefined なら変えない。 */
  dueOn?: string | null;
  /**
   * 依頼者のメール。元の依頼（intake_requests.requester_email）に持つ。
   * 文書のメールの下書きで「担当者への確認」の宛先になる。null で消す。
   */
  requesterEmail?: string | null;
}

export interface MoveInput {
  mode: "new" | "existing";
  matterId?: number | null;
  kind?: MatterKind | null;
  title?: string | null;
  ownerStaffId?: number | null;
}

export class TaskWriteService {
  constructor(
    private readonly database: Transactable,
    /** 依頼者へ Slack で知らせる（案件に移したとき）。無ければ知らせない。 */
    private readonly notify?: (requestId: number, text: string, actor: string) => Promise<boolean>
  ) {}

  /** 状態・担当・期日・件名。完了にしたら done_at、完了から戻したら消す。 */
  async update(id: number, patch: TaskPatch, actor: string): Promise<{ id: number; status: string }> {
    if (patch.status !== undefined && !TASK_STATUSES.includes(patch.status)) {
      throw new DomainError("VALIDATION", "状態は 未着手・作業中・待ち・完了 のいずれかです");
    }
    const title = patch.title === undefined ? undefined : String(patch.title ?? "").trim();
    if (title !== undefined && !title) throw new DomainError("VALIDATION", "件名は空にできません");
    const requesterEmail = patch.requesterEmail === undefined ? undefined
      : String(patch.requesterEmail ?? "").trim().toLowerCase() || null;
    if (requesterEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(requesterEmail)) {
      throw new DomainError("VALIDATION", "依頼者のメールの形が正しくありません");
    }
    try {
      return await inTransaction(this.database, async (client) => {
        const row = await lockTask(client, id);
        const status = patch.status ?? String(row.status);
        if (requesterEmail !== undefined) {
          if (!row.request_id) throw new DomainError("VALIDATION", "依頼から起こした作業ではないので、依頼者のメールは持てません");
          await client.query(
            "UPDATE intake_requests SET requester_email = $2, updated_at = now() WHERE id = $1",
            [row.request_id, requesterEmail]);
        }
        await client.query(
          `UPDATE tasks
              SET status = $2,
                  title = COALESCE($3, title),
                  assignee_staff_id = CASE WHEN $4::boolean THEN $5::bigint ELSE assignee_staff_id END,
                  due_at = CASE WHEN $6::boolean THEN ($7::date::timestamp AT TIME ZONE 'Asia/Tokyo') ELSE due_at END,
                  done_at = CASE WHEN $2 = 'done' THEN COALESCE(done_at, now()) ELSE NULL END,
                  done_by = CASE WHEN $2 = 'done' THEN COALESCE(done_by, $8) ELSE NULL END,
                  updated_at = now()
            WHERE id = $1`,
          [id, status, title ?? null,
           patch.assigneeStaffId !== undefined, patch.assigneeStaffId ?? null,
           patch.dueOn !== undefined, patch.dueOn ?? null, actor]);
        await recordAudit(client, {
          actor, action: "task.update", targetType: "task", targetId: id,
          detail: { from: row.status, to: status, matterId: row.matter_id ?? null, requestId: row.request_id ?? null,
                    ...(patch.assigneeStaffId !== undefined ? { assigneeStaffId: patch.assigneeStaffId ?? null } : {}),
                    ...(patch.dueOn !== undefined ? { dueOn: patch.dueOn ?? null } : {}),
                    ...(requesterEmail !== undefined ? { requesterEmail } : {}) }
        });
        return { id, status };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * デイリータスクを案件に移す。案件を新しく立てるか、既存の案件を選ぶ。
   * 依頼の原票（Backlog・メール・資料）と、繋いであった条件・文書も案件に付ける。
   */
  async moveToMatter(id: number, input: MoveInput, actor: string)
    : Promise<{ id: number; matterId: number; matterNo: string | null; createdMatter: boolean; notified: boolean }> {
    let requestId = 0;
    let message = "";
    let result: { id: number; matterId: number; matterNo: string | null; createdMatter: boolean };
    try {
      result = await inTransaction(this.database, async (client) => {
        const task = await lockTask(client, id);
        if (task.matter_id) throw new DomainError("CONFLICT", "この作業はもう案件に入っています");
        if (!task.request_id) throw new DomainError("CONFLICT", "依頼から起こした作業ではありません");
        const rr = await client.query("SELECT * FROM intake_requests WHERE id = $1 FOR UPDATE", [task.request_id]);
        const row = rr.rows[0] as Record<string, any> | undefined;
        if (!row) throw new DomainError("NOT_FOUND", `依頼 ${task.request_id} が見つかりません`);
        requestId = Number(row.id);

        const title = String(input.title ?? task.title).trim() || String(task.title);
        let matterId: number;
        let matterNo: string | null;
        let createdMatter = false;
        if (input.mode === "new") {
          const kind: MatterKind = input.kind ?? (row.kind as MatterKind | null) ?? "single";
          let counterpartyId = row.counterparty_id ? Number(row.counterparty_id) : null;
          if (!counterpartyId) {
            counterpartyId = (await resolveCounterparty(client, row.counterparty_name ?? null))?.id ?? null;
          }
          const remarks = [
            row.detail,
            `デイリータスクから案件に移した（${row.request_no ?? `#${requestId}`}）`
          ].filter(Boolean).join("\n\n");
          const opened = await openMatter(client, {
            title, kind, counterpartyId,
            counterpartyWritten: row.counterparty_name ?? null,
            ownerStaffId: input.ownerStaffId ?? (task.assignee_staff_id ? Number(task.assignee_staff_id) : null),
            requesterSlackId: row.requester_slack_id ?? null,
            dueOn: dateStr(task.due_at) ?? dateStr(row.due_on),
            remarks, createdBy: actor
          });
          matterId = opened.id; matterNo = opened.matterNo; createdMatter = true;
          await recordAudit(client, {
            actor, action: "matter.intake", targetType: "matter", targetId: matterId,
            detail: { source: "daily-task", taskId: id, requestId, requestNo: row.request_no, kind, matterNo }
          });
        } else {
          if (!input.matterId) throw new DomainError("VALIDATION", "移す先の案件を選んでください");
          const m = await client.query(
            "SELECT id, matter_no, merged_into_id FROM matters WHERE id = $1", [input.matterId]);
          const matter = m.rows[0] as any;
          if (!matter) throw new DomainError("NOT_FOUND", `案件 ${input.matterId} が見つかりません`);
          if (matter.merged_into_id) {
            throw new DomainError("CONFLICT", "統合済みの案件には移せません。統合先の案件を選んでください");
          }
          matterId = Number(matter.id); matterNo = matter.matter_no ?? null;
        }

        await connectRequestToMatter(client, row, matterId, actor);

        // 繋いであった条件は案件に付け、文書は案件に載せる（案件の中で続きをやる）。
        const links = await client.query(
          `SELECT l.target_type, l.target_id, c.condition_no, c.kind
             FROM intake_request_links l
             LEFT JOIN conditions c ON l.target_type = 'condition' AND c.id = l.target_id
            WHERE l.request_id = $1 AND l.target_type IN ('condition', 'document')`, [requestId]);
        for (const l of links.rows as any[]) {
          if (l.target_type === "condition") {
            await client.query(
              `INSERT INTO matter_links (matter_id, target_type, target_ref, relation, snapshot)
               VALUES ($1, 'condition', $2, 'covers', $3::jsonb)
               ON CONFLICT (matter_id, target_type, target_ref) DO NOTHING`,
              [matterId, String(l.target_id), JSON.stringify({ conditionNo: l.condition_no ?? null, kind: l.kind ?? null })]);
          } else {
            await client.query(
              "UPDATE documents SET matter_id = $2 WHERE id = $1 AND matter_id IS NULL", [l.target_id, matterId]);
          }
        }

        await client.query(
          `UPDATE tasks SET matter_id = $2, title = $3, updated_at = now() WHERE id = $1`, [id, matterId, title]);
        await client.query(
          `UPDATE intake_requests
              SET handling = 'matter', matter_id = $2, title = $3, updated_at = now()
            WHERE id = $1`, [requestId, matterId, title]);
        await recordAudit(client, {
          actor, action: "task.move_to_matter", targetType: "task", targetId: id,
          detail: { requestId, requestNo: row.request_no, matterId, matterNo, createdMatter }
        });
        message = [
          `依頼 *${row.request_no ?? `#${requestId}`}* は案件として進めることにしました。`,
          `案件：${matterNo ?? `#${matterId}`} ${title}`
        ].join("\n");
        return { id, matterId, matterNo, createdMatter };
      });
    } catch (error) { throw translate(error); }
    const notified = this.notify ? await this.notify(requestId, message, actor) : false;
    return { ...result, notified };
  }
}

async function lockTask(client: Queryable, id: number): Promise<Record<string, any>> {
  const r = await client.query("SELECT * FROM tasks WHERE id = $1 FOR UPDATE", [id]);
  const row = r.rows[0] as Record<string, any> | undefined;
  if (!row) throw new DomainError("NOT_FOUND", `作業 ${id} が見つかりません`);
  return row;
}
