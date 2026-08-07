import type { DatabasePool } from "../db/pool.js";

export interface MatterSummary {
  id: number; matterCode: string | null; title: string; status: string;
  counterparty: string; primaryIssueKey: string | null; lifecycleStage: string | null;
  ownerName: string | null; targetDueDate: string | null; blockedReason: string | null;
  issueCount: number; documentCount: number; openTaskCount: number;
  nextTaskTitle: string | null; nextTaskDueAt: string | null; updatedAt: string;
  requesterEmail?: string | null;
}
export interface MatterDetail {
  matter: MatterSummary & { remarks: string | null; driveFolderUrl: string | null };
  issues: Array<{ issueKey: string; relation: string; summary: string | null; note: string | null }>;
  tasks: Array<{ id: number; title: string; status: string; assigneeName: string | null; dueAt: string | null; isPrimary: boolean; blockedReason: string | null }>;
  documents: Array<{ id: number; documentNumber: string | null; templateType: string; issueKey: string; createdAt: string; driveLink: string }>;
}
export interface MatterRepository {
  list(query: string, status?: string, limit?: number): Promise<MatterSummary[]>;
  find(id: number): Promise<MatterDetail | null>;
}

export class PgMatterRepository implements MatterRepository {
  constructor(private readonly database: DatabasePool) {}
  async list(query: string, status?: string, limit = 200) {
    const keyword = `%${query.trim()}%`;
    const result = await this.database.query(
      `SELECT * FROM matter_overview_v
        WHERE ($1 = '%%' OR title ILIKE $1 OR COALESCE(matter_code, '') ILIKE $1
          OR COALESCE(counterparty, '') ILIKE $1 OR COALESCE(primary_issue_key, '') ILIKE $1)
          AND ($2 = '' OR status = $2)
        ORDER BY updated_at DESC NULLS LAST
        LIMIT $3`,
      [keyword, status ?? "", Math.min(Math.max(limit, 1), 500)]
    );
    return result.rows.map(mapSummary);
  }
  async find(id: number) {
    const [matterResult, issuesResult, tasksResult, documentsResult] = await Promise.all([
      this.database.query(
        `SELECT v.*, m.remarks, m.drive_folder_url
           FROM matter_overview_v v JOIN matters m ON m.id = v.id WHERE v.id = $1`, [id]),
      this.database.query(
        `SELECT backlog_issue_key, relation, summary_snapshot, note
           FROM matter_issues WHERE matter_id = $1 ORDER BY relation, backlog_issue_key`, [id]),
      this.database.query(
        `SELECT t.id, t.title, t.status, t.due_at, t.is_primary, t.blocked_reason,
                s.staff_name AS assignee_name
           FROM matter_tasks t LEFT JOIN staff s ON s.id = t.assignee_staff_id
          WHERE t.matter_id = $1
          ORDER BY t.is_primary DESC, (t.status IN ('open','in_progress')) DESC,
                   t.due_at NULLS LAST, t.id`, [id]),
      this.database.query(
        `SELECT id, document_number, template_type, issue_key, created_at, drive_link
           FROM documents WHERE matter_id = $1 ORDER BY created_at DESC NULLS LAST, id DESC`, [id])
    ]);
    if (!matterResult.rows[0]) return null;
    const row = matterResult.rows[0];
    return {
      matter: { ...mapSummary(row), remarks: row.remarks, driveFolderUrl: row.drive_folder_url },
      issues: issuesResult.rows.map((issue) => ({
        issueKey: issue.backlog_issue_key, relation: issue.relation,
        summary: issue.summary_snapshot, note: issue.note
      })),
      tasks: tasksResult.rows.map((task) => ({
        id: Number(task.id), title: task.title, status: task.status,
        assigneeName: task.assignee_name, dueAt: iso(task.due_at),
        isPrimary: Boolean(task.is_primary), blockedReason: task.blocked_reason
      })),
      documents: documentsResult.rows.map((document) => ({
        id: Number(document.id), documentNumber: document.document_number,
        templateType: document.template_type, issueKey: document.issue_key,
        createdAt: iso(document.created_at) ?? "", driveLink: document.drive_link ?? ""
      }))
    };
  }
}

export class MemoryMatterRepository implements MatterRepository {
  constructor(private readonly details: MatterDetail[] = []) {}
  async list(query: string, status?: string, limit = 200) {
    const keyword = query.trim().toLowerCase();
    return this.details.map((item) => item.matter)
      .filter((item) => !status || item.status === status)
      .filter((item) => !keyword || [item.matterCode, item.title, item.counterparty, item.primaryIssueKey]
        .some((value) => value?.toLowerCase().includes(keyword))).slice(0, limit);
  }
  async find(id: number) { return this.details.find((item) => item.matter.id === id) ?? null; }
}

function mapSummary(row: Record<string, any>): MatterSummary {
  return {
    id: Number(row.id), matterCode: row.matter_code, title: row.title,
    status: row.status, counterparty: row.counterparty ?? "",
    primaryIssueKey: row.primary_issue_key, lifecycleStage: row.lifecycle_stage,
    ownerName: row.owner_name, targetDueDate: dateOnly(row.target_due_date),
    blockedReason: row.blocked_reason, issueCount: Number(row.issue_count ?? 0),
    documentCount: Number(row.document_count ?? 0), openTaskCount: Number(row.open_task_count ?? 0),
    nextTaskTitle: row.next_task_title, nextTaskDueAt: iso(row.next_task_due_at),
    updatedAt: iso(row.updated_at) ?? "",
    requesterEmail: optionalEmail(
      row.requester_email ?? row.created_by ?? row.requester
    )
  };
}
// 依頼者メールの正規化。matter_overview_v が requester_email / created_by /
// requester のいずれかで返す値を検証する。正規表現リテラルなので単一エスケープ。
// （旧実装は \\s / \\. と二重エスケープされ、全ての正当なメールを null にしていた
//  ＝Slack候補フローの宛先解決が常に失敗する原因だった）
export function optionalEmail(value: unknown): string | null {
  const email = String(value ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}
function iso(value: unknown) { return value ? new Date(String(value)).toISOString() : null; }
function dateOnly(value: unknown) { return value ? String(value).slice(0, 10) : null; }
