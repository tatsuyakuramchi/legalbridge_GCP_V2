import type { DatabasePool } from "../db/pool.js";

export interface MatterSummary {
  id: number; matterCode: string | null; title: string; status: string;
  counterparty: string; primaryIssueKey: string | null; lifecycleStage: string | null;
  ownerName: string | null; targetDueDate: string | null; blockedReason: string | null;
  issueCount: number; documentCount: number; openTaskCount: number;
  nextTaskTitle: string | null; nextTaskDueAt: string | null; updatedAt: string;
  ownerStaffId?: number | null;
  requesterEmail?: string | null;
}
export interface MatterDetail {
  matter: MatterSummary & { remarks: string | null; driveFolderUrl: string | null; ownerStaffId?: number | null };
  issues: Array<{
    issueKey: string; relation: string; summary: string | null; note: string | null;
    requestId?: number | null; requestType?: string | null; requestCounterparty?: string | null;
  }>;
  tasks: Array<{ id: number; title: string; status: string; assigneeName: string | null; assigneeStaffId?: number | null; dueAt: string | null; isPrimary: boolean; blockedReason: string | null }>;
  documents: Array<{ id: number; documentNumber: string | null; templateType: string; issueKey: string; createdAt: string; driveLink: string }>;
  contracts?: Array<{ id: number; documentNumber: string | null; title: string; contractType: string | null; status: string | null; expirationDate: string | null }>;
  works?: Array<{ id: number; workCode: string | null; title: string }>;
  vendors?: Array<{ id: number; vendorCode: string | null; name: string }>;
  deliveryEvents?: Array<{ id: number; status: string; inspectionDeadline: string | null; deliveredAmount: number | null; backlogIssueKey?: string | null }>;
  payments?: Array<{
    id: number; status: string; dueDate: string | null; paidDate?: string | null; amount: number | null; currency: string;
    sourceDocumentNumber: string | null; paymentKind?: string | null; backlogIssueKey?: string | null;
  }>;
  deadlines?: Array<{ id: string; kind: "matter" | "task" | "document" | "contract"; title: string; dueDate: string; status: string }>;
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
    const [matterResult, issuesResult, tasksResult, documentsResult, contractsResult, worksResult, vendorsResult, deliveryResult, paymentResult, deadlinesResult] = await Promise.all([
      this.database.query(
        `SELECT v.*, m.remarks, m.drive_folder_url, m.owner_staff_id
           FROM matter_overview_v v JOIN matters m ON m.id = v.id WHERE v.id = $1`, [id]),
      this.database.query(
        `SELECT mi.backlog_issue_key, mi.relation, mi.summary_snapshot, mi.note,
                lr.id AS request_id, lr.contract_type AS request_type,
                lr.counterparty AS request_counterparty
           FROM matter_issues mi
           LEFT JOIN legal_requests lr ON lr.backlog_issue_key = mi.backlog_issue_key
          WHERE mi.matter_id = $1
          ORDER BY ((SELECT primary_issue_key FROM matters WHERE id = $1) = mi.backlog_issue_key) DESC NULLS LAST,
                   mi.relation, mi.backlog_issue_key`, [id]),
      this.database.query(
        `SELECT t.id, t.title, t.status, t.due_at, t.is_primary, t.blocked_reason,
                t.assignee_staff_id, s.staff_name AS assignee_name
           FROM matter_tasks t LEFT JOIN staff s ON s.id = t.assignee_staff_id
          WHERE t.matter_id = $1
          ORDER BY t.is_primary DESC, (t.status IN ('open','in_progress')) DESC,
                   t.due_at NULLS LAST, t.id`, [id]),
      this.database.query(
        `SELECT id, document_number, template_type, issue_key, created_at, drive_link
           FROM documents WHERE matter_id = $1 ORDER BY created_at DESC NULLS LAST, id DESC`, [id]),
      this.database.query(
        `SELECT DISTINCT c.id, c.document_number, c.contract_title, c.contract_type,
                c.contract_status, c.expiration_date
           FROM contracts c
           JOIN documents d ON d.contract_id = c.id
          WHERE d.matter_id = $1
             OR d.issue_key IN (SELECT backlog_issue_key FROM matter_issues WHERE matter_id = $1)
             OR d.backlog_issue_key IN (SELECT backlog_issue_key FROM matter_issues WHERE matter_id = $1)
          ORDER BY c.expiration_date NULLS LAST, c.id DESC`, [id]),
      this.database.query(
        `SELECT DISTINCT w.id, w.work_code, w.title
           FROM works w
           JOIN (
             SELECT cl.work_id FROM documents d JOIN condition_lines cl ON cl.document_id = d.id
              WHERE (d.matter_id = $1 OR d.issue_key IN (SELECT backlog_issue_key FROM matter_issues WHERE matter_id = $1)
                     OR d.backlog_issue_key IN (SELECT backlog_issue_key FROM matter_issues WHERE matter_id = $1))
                AND cl.work_id IS NOT NULL
             UNION
             SELECT cw.work_id FROM documents d JOIN contract_works cw ON cw.contract_id = d.contract_id
              WHERE d.matter_id = $1 OR d.issue_key IN (SELECT backlog_issue_key FROM matter_issues WHERE matter_id = $1)
                     OR d.backlog_issue_key IN (SELECT backlog_issue_key FROM matter_issues WHERE matter_id = $1)
           ) linked ON linked.work_id = w.id
          ORDER BY w.title, w.id`, [id]),
      this.database.query(
        `SELECT DISTINCT v.id, v.vendor_code, v.vendor_name
           FROM vendors v
           JOIN (
             SELECT d.vendor_id FROM documents d
              WHERE (d.matter_id = $1 OR d.issue_key IN (SELECT backlog_issue_key FROM matter_issues WHERE matter_id = $1)
                     OR d.backlog_issue_key IN (SELECT backlog_issue_key FROM matter_issues WHERE matter_id = $1))
                AND d.vendor_id IS NOT NULL
             UNION
             SELECT c.primary_vendor_id FROM documents d JOIN contracts c ON c.id = d.contract_id
              WHERE (d.matter_id = $1 OR d.issue_key IN (SELECT backlog_issue_key FROM matter_issues WHERE matter_id = $1)
                     OR d.backlog_issue_key IN (SELECT backlog_issue_key FROM matter_issues WHERE matter_id = $1))
                AND c.primary_vendor_id IS NOT NULL
           ) linked ON linked.vendor_id = v.id
          ORDER BY v.vendor_name, v.id`, [id]),
      this.database.query(
        `SELECT de.id, de.status, de.inspection_deadline, de.delivered_amount, de.backlog_issue_key
           FROM delivery_events de
          WHERE de.backlog_issue_key = (SELECT primary_issue_key FROM matters WHERE id = $1)
             OR de.backlog_issue_key IN (SELECT backlog_issue_key FROM matter_issues WHERE matter_id = $1)
          ORDER BY de.id DESC`, [id]),
      this.database.query(
        `SELECT p.id, p.status, p.due_date, p.paid_date, COALESCE(p.total_amount,p.amount_ex_tax) AS amount,
                p.currency, p.source_document_number, p.payment_kind, p.backlog_issue_key
           FROM payments p
          WHERE p.backlog_issue_key = (SELECT primary_issue_key FROM matters WHERE id = $1)
             OR p.backlog_issue_key IN (SELECT backlog_issue_key FROM matter_issues WHERE matter_id = $1)
          ORDER BY p.due_date DESC NULLS LAST, p.id DESC`, [id]),
      this.database.query(
        `SELECT * FROM (
           SELECT 'matter:' || m.id AS id, 'matter'::text AS kind, m.title,
                  m.target_due_date::text AS due_date, m.status::text AS status
             FROM matters m WHERE m.id = $1 AND m.target_due_date IS NOT NULL
           UNION ALL
           SELECT 'task:' || t.id, 'task', t.title,
                  (t.due_at AT TIME ZONE 'Asia/Tokyo')::date::text, t.status::text
             FROM matter_tasks t WHERE t.matter_id = $1 AND t.due_at IS NOT NULL
           UNION ALL
           SELECT 'document:' || d.id, 'document',
                  COALESCE(NULLIF(d.contract_title,''), d.document_number, d.template_type),
                  d.due_date::text, COALESCE(d.lifecycle_status,d.contract_status,'active')::text
             FROM documents d WHERE d.matter_id = $1 AND d.due_date IS NOT NULL
           UNION
           SELECT 'contract:' || c.id, 'contract',
                  COALESCE(NULLIF(c.contract_title,''), c.document_number, '契約'),
                  c.expiration_date::text, COALESCE(c.contract_status,'active')::text
             FROM documents d JOIN contracts c ON c.id = d.contract_id
            WHERE d.matter_id = $1 AND c.expiration_date IS NOT NULL
         ) deadlines ORDER BY due_date, kind, id`, [id])
    ]);
    if (!matterResult.rows[0]) return null;
    const row = matterResult.rows[0];
    return {
      matter: { ...mapSummary(row), remarks: row.remarks, driveFolderUrl: row.drive_folder_url,
        ownerStaffId: row.owner_staff_id == null ? null : Number(row.owner_staff_id) },
      issues: issuesResult.rows.map((issue) => ({
        issueKey: issue.backlog_issue_key, relation: issue.relation,
        summary: issue.summary_snapshot, note: issue.note,
        requestId: issue.request_id === null ? null : Number(issue.request_id),
        requestType: issue.request_type ?? null,
        requestCounterparty: issue.request_counterparty ?? null
      })),
      tasks: tasksResult.rows.map((task) => ({
        id: Number(task.id), title: task.title, status: task.status,
        assigneeName: task.assignee_name,
        assigneeStaffId: task.assignee_staff_id == null ? null : Number(task.assignee_staff_id),
        dueAt: iso(task.due_at),
        isPrimary: Boolean(task.is_primary), blockedReason: task.blocked_reason
      })),
      documents: documentsResult.rows.map((document) => ({
        id: Number(document.id), documentNumber: document.document_number,
        templateType: document.template_type, issueKey: document.issue_key,
        createdAt: iso(document.created_at) ?? "", driveLink: document.drive_link ?? ""
      })),
      contracts: contractsResult.rows.map((contract) => ({
        id: Number(contract.id), documentNumber: contract.document_number ?? null,
        title: String(contract.contract_title ?? contract.document_number ?? `Contract #${contract.id}`),
        contractType: contract.contract_type ?? null, status: contract.contract_status ?? null,
        expirationDate: dateOnly(contract.expiration_date)
      })),
      works: worksResult.rows.map((work) => ({
        id: Number(work.id), workCode: work.work_code ?? null, title: String(work.title ?? `Work #${work.id}`)
      })),
      vendors: vendorsResult.rows.map((vendor) => ({
        id: Number(vendor.id), vendorCode: vendor.vendor_code ?? null, name: String(vendor.vendor_name ?? "")
      })),
      deliveryEvents: deliveryResult.rows.map((event) => ({
        id: Number(event.id), status: String(event.status ?? ""),
        inspectionDeadline: dateOnly(event.inspection_deadline),
        deliveredAmount: event.delivered_amount === null ? null : Number(event.delivered_amount),
        backlogIssueKey: event.backlog_issue_key ?? null
      })),
      payments: paymentResult.rows.map((payment) => ({
        id: Number(payment.id), status: String(payment.status ?? ""), dueDate: dateOnly(payment.due_date),
        paidDate: dateOnly(payment.paid_date),
        amount: payment.amount === null ? null : Number(payment.amount), currency: String(payment.currency ?? "JPY"),
        sourceDocumentNumber: payment.source_document_number ?? null,
        paymentKind: payment.payment_kind ?? null, backlogIssueKey: payment.backlog_issue_key ?? null
      })),
      deadlines: deadlinesResult.rows.map((deadline) => ({
        id: String(deadline.id), kind: deadline.kind, title: String(deadline.title ?? ""),
        dueDate: String(deadline.due_date), status: String(deadline.status ?? "")
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
    ownerStaffId: row.owner_staff_id === null || row.owner_staff_id === undefined ? null : Number(row.owner_staff_id),
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
