import type { DatabasePool } from "../db/pool.js";

export type DeadlineEventType =
  | "matter_due"
  | "task_due"
  | "contract_expiration"
  | "renewal_notice"
  | "installment_due"
  | "inspection_due"
  | "payment_due"
  | "document_due"
  | "request_due";

export interface DeadlineEvent {
  id: string;
  eventType: DeadlineEventType;
  title: string;
  dueDate: string;
  status: string;
  sourceType: string;
  sourceId: number;
  matterId: number | null;
  matterCode: string | null;
  matterTitle: string | null;
  counterparty: string | null;
  workTitle: string | null;
  documentNumber: string | null;
  amount: number | null;
  currency: string | null;
  ownerName: string | null;
}

export interface DeadlineRepository {
  list(from: string, to: string): Promise<DeadlineEvent[]>;
}

export class PgDeadlineRepository implements DeadlineRepository {
  constructor(private readonly database: DatabasePool) {}

  async list(from: string, to: string) {
    const result = await this.database.query(
      `WITH deadline_events AS (
        SELECT
          'request:' || lr.id AS event_id,
          'request_due'::text AS event_type,
          COALESCE(NULLIF(lr.summary,''), lr.backlog_issue_key, '法務依頼') AS title,
          lr.deadline::date::text AS due_date,
          CASE WHEN EXISTS (
            SELECT 1 FROM documents rd
            WHERE (rd.issue_key = lr.backlog_issue_key OR rd.backlog_issue_key = lr.backlog_issue_key)
              AND rd.template_type = 'legal_response'
          ) THEN 'completed' ELSE 'open' END AS status,
          'legal_request'::text AS source_type,
          lr.id AS source_id,
          linked.matter_id,
          linked.matter_code,
          linked.matter_title,
          lr.counterparty,
          NULL::text AS work_title,
          NULL::text AS document_number,
          NULL::numeric AS amount,
          NULL::text AS currency,
          NULL::text AS owner_name
        FROM legal_requests lr
        LEFT JOIN LATERAL (
          SELECT m.id AS matter_id, m.matter_code, m.title AS matter_title
          FROM matter_issues mi
          JOIN matters m ON m.id = mi.matter_id
          WHERE mi.backlog_issue_key = lr.backlog_issue_key
          ORDER BY (mi.relation = 'primary') DESC, mi.id
          LIMIT 1
        ) linked ON true
        WHERE lr.deadline IS NOT NULL

        UNION ALL

        SELECT
          'matter:' || m.id AS event_id,
          'matter_due'::text AS event_type,
          m.title AS title,
          m.target_due_date::text AS due_date,
          m.status::text AS status,
          'matter'::text AS source_type,
          m.id AS source_id,
          m.id AS matter_id,
          m.matter_code,
          m.title AS matter_title,
          m.counterparty,
          NULL::text AS work_title,
          NULL::text AS document_number,
          NULL::numeric AS amount,
          NULL::text AS currency,
          s.staff_name AS owner_name
        FROM matters m
        LEFT JOIN staff s ON s.id = m.owner_staff_id
        WHERE m.target_due_date IS NOT NULL
          AND m.status NOT IN ('closed','archived')

        UNION ALL

        SELECT
          'task:' || t.id,
          'task_due',
          t.title,
          t.due_at::text,
          t.status::text,
          'matter_task',
          t.id,
          m.id,
          m.matter_code,
          m.title,
          m.counterparty,
          NULL::text,
          NULL::text,
          NULL::numeric,
          NULL::text,
          s.staff_name
        FROM matter_tasks t
        JOIN matters m ON m.id = t.matter_id
        LEFT JOIN staff s ON s.id = t.assignee_staff_id
        WHERE t.due_at IS NOT NULL
          AND t.status IN ('open','in_progress')

        UNION ALL

        SELECT
          'contract-exp:' || c.id,
          'contract_expiration',
          COALESCE(NULLIF(c.contract_title,''), c.document_number, '契約') || ' 契約終了',
          c.expiration_date::text,
          COALESCE(c.contract_status,'active')::text,
          'contract',
          c.id,
          d.matter_id,
          m.matter_code,
          m.title,
          v.vendor_name,
          w.title,
          COALESCE(c.document_number,d.document_number),
          NULL::numeric,
          NULL::text,
          NULL::text
        FROM contracts c
        LEFT JOIN documents d ON d.contract_id = c.id AND d.is_active = true
        LEFT JOIN matters m ON m.id = d.matter_id
        LEFT JOIN vendors v ON v.id = c.primary_vendor_id
        LEFT JOIN contract_works cw ON cw.contract_id = c.id
        LEFT JOIN works w ON w.id = cw.work_id
        WHERE c.expiration_date IS NOT NULL
          AND COALESCE(c.contract_status,'') NOT IN ('cancelled','terminated','expired')

        UNION ALL

        SELECT
          'contract-renew:' || c.id,
          'renewal_notice',
          COALESCE(NULLIF(c.contract_title,''), c.document_number, '契約') || ' 更新通知期限',
          (c.expiration_date - make_interval(months => c.renewal_notice_months))::date::text,
          COALESCE(c.contract_status,'active')::text,
          'contract',
          c.id,
          d.matter_id,
          m.matter_code,
          m.title,
          v.vendor_name,
          w.title,
          COALESCE(c.document_number,d.document_number),
          NULL::numeric,
          NULL::text,
          NULL::text
        FROM contracts c
        LEFT JOIN documents d ON d.contract_id = c.id AND d.is_active = true
        LEFT JOIN matters m ON m.id = d.matter_id
        LEFT JOIN vendors v ON v.id = c.primary_vendor_id
        LEFT JOIN contract_works cw ON cw.contract_id = c.id
        LEFT JOIN works w ON w.id = cw.work_id
        WHERE c.expiration_date IS NOT NULL
          AND c.auto_renewal = true
          AND c.renewal_notice_months IS NOT NULL
          AND c.renewal_notice_months > 0
          AND COALESCE(c.contract_status,'') NOT IN ('cancelled','terminated','expired')

        UNION ALL

        SELECT
          'installment:' || i.id,
          'installment_due',
          COALESCE(NULLIF(cl.condition_name,''),'契約条件') || ' 支払・精算予定',
          i.due_date::text,
          CASE WHEN EXISTS (
            SELECT 1 FROM condition_events e
            WHERE e.installment_id = i.id AND e.voided_at IS NULL
          ) THEN 'settled' ELSE 'open' END,
          'condition_installment',
          i.id,
          d.matter_id,
          m.matter_code,
          m.title,
          v.vendor_name,
          w.title,
          d.document_number,
          i.planned_amount_ex_tax,
          cl.currency,
          NULL::text
        FROM condition_line_installments i
        JOIN condition_lines cl ON cl.id = i.condition_line_id
        LEFT JOIN documents d ON d.id = cl.document_id
        LEFT JOIN matters m ON m.id = d.matter_id
        LEFT JOIN vendors v ON v.id = cl.counterparty_vendor_id
        LEFT JOIN works w ON w.id = cl.work_id
        WHERE i.due_date IS NOT NULL

        UNION ALL

        SELECT
          'inspection:' || de.id,
          'inspection_due',
          COALESCE(mi.summary_snapshot, de.backlog_issue_key, '納品') || ' 検収期限',
          de.inspection_deadline::text,
          de.status::text,
          'delivery_event',
          de.id,
          mi.matter_id,
          m.matter_code,
          m.title,
          m.counterparty,
          NULL::text,
          NULL::text,
          de.delivered_amount,
          'JPY'::text,
          NULL::text
        FROM delivery_events de
        LEFT JOIN LATERAL (
          SELECT x.matter_id, x.summary_snapshot
          FROM matter_issues x
          WHERE x.backlog_issue_key = de.backlog_issue_key
          ORDER BY x.id
          LIMIT 1
        ) mi ON true
        LEFT JOIN matters m ON m.id = mi.matter_id
        WHERE de.inspection_deadline IS NOT NULL
          AND COALESCE(de.status,'') NOT IN ('inspected','completed','cancelled')

        UNION ALL

        SELECT
          'payment:' || p.id,
          'payment_due',
          COALESCE(v.vendor_name,w.title,p.source_document_number,'支払') || ' 支払期限',
          p.due_date::text,
          p.status::text,
          'payment',
          p.id,
          mi.matter_id,
          m.matter_code,
          m.title,
          v.vendor_name,
          w.title,
          p.source_document_number,
          COALESCE(p.total_amount,p.amount_ex_tax),
          p.currency,
          NULL::text
        FROM payments p
        LEFT JOIN vendors v ON v.id = p.counterparty_vendor_id
        LEFT JOIN works w ON w.id = p.work_id
        LEFT JOIN LATERAL (
          SELECT x.matter_id
          FROM matter_issues x
          WHERE x.backlog_issue_key = p.backlog_issue_key
          ORDER BY x.id
          LIMIT 1
        ) mi ON true
        LEFT JOIN matters m ON m.id = mi.matter_id
        WHERE p.due_date IS NOT NULL
          AND COALESCE(p.status,'') NOT IN ('paid','completed','cancelled')

        UNION ALL

        SELECT
          'document:' || d.id,
          'document_due',
          COALESCE(NULLIF(d.contract_title,''),d.document_number,d.template_type) || ' 期日',
          d.due_date::text,
          COALESCE(d.lifecycle_status,d.contract_status,'active')::text,
          'document',
          d.id,
          d.matter_id,
          m.matter_code,
          m.title,
          COALESCE(v.vendor_name,d.vendor_name_snapshot),
          d.work_name,
          d.document_number,
          COALESCE(d.amount_inc_tax,d.amount_ex_tax),
          'JPY'::text,
          NULL::text
        FROM documents d
        LEFT JOIN matters m ON m.id = d.matter_id
        LEFT JOIN vendors v ON v.id = d.vendor_id
        WHERE d.due_date IS NOT NULL
          AND d.is_active = true
      )
      SELECT *
      FROM deadline_events
      WHERE due_date::date BETWEEN $1::date AND $2::date
      ORDER BY due_date::date, event_type, event_id`,
      [from, to]
    );
    return result.rows.map(mapRow);
  }
}

function mapRow(row: Record<string, any>): DeadlineEvent {
  return {
    id: String(row.event_id),
    eventType: row.event_type as DeadlineEventType,
    title: String(row.title ?? ""),
    dueDate: String(row.due_date ?? "").slice(0, 10),
    status: String(row.status ?? "open"),
    sourceType: String(row.source_type ?? ""),
    sourceId: Number(row.source_id),
    matterId: row.matter_id === null ? null : Number(row.matter_id),
    matterCode: row.matter_code ?? null,
    matterTitle: row.matter_title ?? null,
    counterparty: row.counterparty ?? null,
    workTitle: row.work_title ?? null,
    documentNumber: row.document_number ?? null,
    amount: num(row.amount),
    currency: row.currency ?? null,
    ownerName: row.owner_name ?? null
  };
}
function num(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export class MemoryDeadlineRepository implements DeadlineRepository {
  constructor(private readonly events: DeadlineEvent[] = []) {}
  async list(from: string, to: string) {
    return this.events.filter((event) => event.dueDate >= from && event.dueDate <= to)
      .sort((a,b) => a.dueDate.localeCompare(b.dueDate));
  }
}
