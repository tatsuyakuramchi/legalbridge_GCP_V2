import type { Queryable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { IntakeRepository, purposeOfTask, taskDueOn } from "../intake/repository.js";
import { loadProgress, paymentDocLabel, type RequestProgress } from "../intake/payment-request.js";

/**
 * 作業テーブル（tasks）の読み取り。docs/v3-request-inbox.md §10（A-064）
 *
 * デイリータスク＝案件の無い作業（matter_id が空。受付箱で「軽微」にした依頼から起こす）。
 * 案件の中の作業は案件の詳細（matters/repository.ts）が返す。
 * 状態は 未着手・作業中・待ち・完了 の 4 つ。進み具合（受付→作成→送付→支払予定→支払）は
 * 保存せず、文書と支払から導く。
 */

export type DailyTab = "open" | "wait" | "late" | "done" | "all";

export interface DailyTaskRow {
  id: number;
  title: string;
  status: string;
  purpose: string;
  purposeLabel: string;
  assigneeStaffId: number | null;
  assigneeName: string | null;
  dueOn: string | null;
  overdue: boolean;
  doneAt: string | null;
  createdAt: string;
  request: {
    id: number; requestNo: string | null; source: string; targetDocNo: string | null;
    counterpartyName: string | null; requesterName: string | null; hasUnseenUpdate: boolean;
  };
  progress: RequestProgress | null;
}

export interface DailyCounts {
  todo: number; doing: number; wait: number; late: number; done: number;
  /** 終わっていない作業の数。ナビの札。 */
  open: number;
}

const SELECT = `
  SELECT t.id, t.title, t.status, t.purpose, t.assignee_staff_id, t.due_at, t.done_at, t.created_at,
         st.name AS assignee_name,
         r.id AS request_id, r.request_no, r.source, r.source_payload, r.requester_name, r.has_unseen_update,
         r.created_at AS request_created_at, r.handled_at,
         COALESCE(p.name, r.counterparty_name) AS counterparty_name,
         ((t.due_at AT TIME ZONE 'Asia/Tokyo')::date < current_date) AS overdue
    FROM tasks t
    JOIN intake_requests r ON r.id = t.request_id
    LEFT JOIN staff st ON st.id = t.assignee_staff_id
    LEFT JOIN parties p ON p.id = r.counterparty_id
   WHERE t.matter_id IS NULL`;

export class DailyTaskRepository {
  constructor(private readonly database: Queryable, private readonly intake: IntakeRepository) {}

  async list(tab: DailyTab = "open", assigneeStaffId: number | null = null): Promise<DailyTaskRow[]> {
    const where = tab === "open" ? "t.status IN ('todo', 'doing')"
      : tab === "wait" ? "t.status = 'blocked'"
      : tab === "late" ? "t.status <> 'done' AND (t.due_at AT TIME ZONE 'Asia/Tokyo')::date < current_date"
      : tab === "done" ? "t.status = 'done'"
      : "TRUE";
    // 終わったものは新しい順、それ以外は期日の近い順。
    const order = tab === "done" ? "t.done_at DESC NULLS LAST, t.id DESC" : "t.due_at NULLS LAST, t.id";
    try {
      const r = await this.database.query(
        `${SELECT} AND ${where}${assigneeStaffId ? " AND t.assignee_staff_id = $1" : ""}
          ORDER BY ${order} LIMIT 300`, assigneeStaffId ? [assigneeStaffId] : []);
      const rows: DailyTaskRow[] = [];
      for (const x of r.rows as any[]) {
        const row = toDaily(x);
        // 進み具合は文書・支払から導く（一覧で「どこで止まっているか」を見る）。
        row.progress = await loadProgress(this.database, {
          id: row.request.id, purpose: purposeOfTask({ purpose: row.purpose }),
          createdAt: iso(x.request_created_at) ?? row.createdAt, acceptedAt: iso(x.handled_at), doneAt: row.doneAt
        });
        rows.push(row);
      }
      return rows;
    } catch (error) { throw translate(error); }
  }

  async counts(assigneeStaffId: number | null = null): Promise<DailyCounts> {
    try {
      const r = await this.database.query(
        `SELECT count(*) FILTER (WHERE status = 'todo')::int AS todo,
                count(*) FILTER (WHERE status = 'doing')::int AS doing,
                count(*) FILTER (WHERE status = 'blocked')::int AS wait,
                count(*) FILTER (WHERE status <> 'done'
                                   AND (due_at AT TIME ZONE 'Asia/Tokyo')::date < current_date)::int AS late,
                count(*) FILTER (WHERE status = 'done' AND done_at > now() - interval '7 days')::int AS done,
                count(*) FILTER (WHERE status <> 'done')::int AS open
           FROM tasks
          WHERE matter_id IS NULL AND request_id IS NOT NULL${assigneeStaffId ? " AND assignee_staff_id = $1" : ""}`,
        assigneeStaffId ? [assigneeStaffId] : []);
      const x = (r.rows[0] ?? {}) as any;
      return { todo: Number(x.todo ?? 0), doing: Number(x.doing ?? 0), wait: Number(x.wait ?? 0),
               late: Number(x.late ?? 0), done: Number(x.done ?? 0), open: Number(x.open ?? 0) };
    } catch (error) { throw translate(error); }
  }

  /** 1 件。作業と、元の依頼の詳細（条件・回・文書・返信）。 */
  async find(id: number): Promise<{ task: DailyTaskRow } & Awaited<ReturnType<IntakeRepository["find"]>>> {
    try {
      const r = await this.database.query(`${SELECT} AND t.id = $1`, [id]);
      const x = r.rows[0] as any;
      if (!x) throw new DomainError("NOT_FOUND", `作業 ${id} が見つかりません（案件に移した作業は案件で開きます）`);
      const task = toDaily(x);
      const detail = await this.intake.find(task.request.id);
      task.progress = detail.request.progress ?? null;
      return { task, ...detail };
    } catch (error) { throw translate(error); }
  }
}

const iso = (v: unknown): string | null =>
  v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v);

function toDaily(x: Record<string, any>): DailyTaskRow {
  const payload = (x.source_payload ?? {}) as Record<string, any>;
  const purpose = purposeOfTask({ purpose: x.purpose ?? payload.purpose ?? null });
  return {
    id: Number(x.id), title: String(x.title), status: String(x.status),
    purpose, purposeLabel: purpose === "other" ? "その他" : paymentDocLabel(purpose),
    assigneeStaffId: x.assignee_staff_id ? Number(x.assignee_staff_id) : null,
    assigneeName: x.assignee_name ?? null,
    dueOn: taskDueOn(x.due_at), overdue: Boolean(x.overdue) && x.status !== "done",
    doneAt: iso(x.done_at), createdAt: iso(x.created_at) ?? "",
    request: {
      id: Number(x.request_id), requestNo: x.request_no ?? null, source: String(x.source),
      targetDocNo: payload.targetDocNo ? String(payload.targetDocNo) : null,
      counterpartyName: x.counterparty_name ?? null, requesterName: x.requester_name ?? null,
      hasUnseenUpdate: Boolean(x.has_unseen_update)
    },
    progress: null
  };
}
