import type { DatabasePool } from "../db/pool.js";

export type RequestDisposition = "received" | "matter_linked" | "document_created" | "completed";

export interface LegalRequestRow {
  id: number;
  issueKey: string;
  summary: string;
  contractType: string | null;
  counterparty: string | null;
  slackUserId: string | null;
  deadline: string | null;
  notes: string | null;
  createdAt: string | null;
  matterCount: number;
  documentCount: number;
  legalResponseCount: number;
  disposition: RequestDisposition;
}

export interface LegalRequestDetail extends LegalRequestRow {
  matters: Array<{
    id: number;
    matterCode: string | null;
    title: string;
    status: string;
    relation: string;
    primary: boolean;
  }>;
  documents: Array<{
    id: number;
    documentNumber: string | null;
    templateType: string;
    driveLink: string;
    createdAt: string | null;
  }>;
  contracts: Array<{
    id: number;
    documentNumber: string | null;
    title: string;
    contractType: string | null;
    status: string | null;
    expirationDate: string | null;
  }>;
  works: Array<{
    id: number;
    workCode: string | null;
    title: string;
  }>;
  vendors: Array<{
    id: number;
    vendorCode: string | null;
    name: string;
  }>;
  deadlines: Array<{
    id: string;
    kind: "request" | "matter" | "task" | "document" | "contract";
    title: string;
    dueDate: string;
    status: string;
  }>;
}

export interface RequestRepository {
  list(query?: string, limit?: number): Promise<LegalRequestRow[]>;
  find(id: number): Promise<LegalRequestDetail | null>;
  linkMatter(requestId: number, matterId: number, primary?: boolean): Promise<LegalRequestDetail>;
}

export class PgRequestRepository implements RequestRepository {
  constructor(private readonly database: DatabasePool) {}

  async list(query = "", limit = 200) {
    const keyword = `%${query.trim()}%`;
    const result = await this.database.query(
      `SELECT lr.id, lr.backlog_issue_key, lr.slack_user_id, lr.contract_type,
              lr.counterparty, lr.summary, lr.deadline, lr.notes, lr.created_at,
              COUNT(DISTINCT mi.matter_id)::int AS matter_count,
              COUNT(DISTINCT d.id)::int AS document_count,
              COUNT(DISTINCT d.id) FILTER (WHERE d.template_type = 'legal_response')::int AS legal_response_count
         FROM legal_requests lr
         LEFT JOIN matter_issues mi ON mi.backlog_issue_key = lr.backlog_issue_key
         LEFT JOIN documents d
           ON d.issue_key = lr.backlog_issue_key
           OR d.backlog_issue_key = lr.backlog_issue_key
        WHERE ($1 = '%%'
          OR lr.backlog_issue_key ILIKE $1
          OR COALESCE(lr.summary, '') ILIKE $1
          OR COALESCE(lr.counterparty, '') ILIKE $1
          OR COALESCE(lr.contract_type, '') ILIKE $1)
        GROUP BY lr.id
        ORDER BY lr.created_at DESC NULLS LAST, lr.id DESC
        LIMIT $2`,
      [keyword, Math.min(Math.max(limit, 1), 500)]
    );
    return result.rows.map(mapRow);
  }

  async find(id: number) {
    const base = await this.database.query(
      `SELECT lr.id, lr.backlog_issue_key, lr.slack_user_id, lr.contract_type,
              lr.counterparty, lr.summary, lr.deadline, lr.notes, lr.created_at,
              COUNT(DISTINCT mi.matter_id)::int AS matter_count,
              COUNT(DISTINCT d.id)::int AS document_count,
              COUNT(DISTINCT d.id) FILTER (WHERE d.template_type = 'legal_response')::int AS legal_response_count
         FROM legal_requests lr
         LEFT JOIN matter_issues mi ON mi.backlog_issue_key = lr.backlog_issue_key
         LEFT JOIN documents d
           ON d.issue_key = lr.backlog_issue_key
           OR d.backlog_issue_key = lr.backlog_issue_key
        WHERE lr.id = $1
        GROUP BY lr.id`,
      [id]
    );
    if (!base.rows[0]) return null;
    const issueKey = String(base.rows[0].backlog_issue_key);
    const [matters, documents, contracts, works, vendors, deadlines] = await Promise.all([
      this.database.query(
        `SELECT m.id, m.matter_code, m.title, m.status, mi.relation,
                (m.primary_issue_key = mi.backlog_issue_key) AS is_primary
           FROM matter_issues mi
           JOIN matters m ON m.id = mi.matter_id
          WHERE mi.backlog_issue_key = $1
          ORDER BY is_primary DESC, m.updated_at DESC, m.id DESC`,
        [issueKey]
      ),
      this.database.query(
        `SELECT id, document_number, template_type, drive_link, created_at
           FROM documents
          WHERE issue_key = $1 OR backlog_issue_key = $1
          ORDER BY created_at DESC NULLS LAST, id DESC`,
        [issueKey]
      ),
      this.database.query(
        `SELECT DISTINCT c.id, c.document_number, c.contract_title, c.contract_type,
                c.contract_status, c.expiration_date
           FROM documents d
           JOIN contracts c ON c.id = d.contract_id
          WHERE d.issue_key = $1 OR d.backlog_issue_key = $1
          ORDER BY c.expiration_date NULLS LAST, c.id DESC`,
        [issueKey]
      ),
      this.database.query(
        `SELECT DISTINCT w.id, w.work_code, w.title
           FROM works w
           JOIN (
             SELECT cl.work_id
               FROM documents d
               JOIN condition_lines cl ON cl.document_id = d.id
              WHERE (d.issue_key = $1 OR d.backlog_issue_key = $1)
                AND cl.work_id IS NOT NULL
             UNION
             SELECT cw.work_id
               FROM documents d
               JOIN contract_works cw ON cw.contract_id = d.contract_id
              WHERE (d.issue_key = $1 OR d.backlog_issue_key = $1)
                AND cw.work_id IS NOT NULL
           ) linked ON linked.work_id = w.id
          ORDER BY w.title, w.id`,
        [issueKey]
      ),
      this.database.query(
        `SELECT DISTINCT v.id, v.vendor_code, v.vendor_name
           FROM vendors v
           JOIN (
             SELECT d.vendor_id
               FROM documents d
              WHERE (d.issue_key = $1 OR d.backlog_issue_key = $1)
                AND d.vendor_id IS NOT NULL
             UNION
             SELECT cl.counterparty_vendor_id
               FROM documents d
               JOIN condition_lines cl ON cl.document_id = d.id
              WHERE (d.issue_key = $1 OR d.backlog_issue_key = $1)
                AND cl.counterparty_vendor_id IS NOT NULL
             UNION
             SELECT c.primary_vendor_id
               FROM documents d
               JOIN contracts c ON c.id = d.contract_id
              WHERE (d.issue_key = $1 OR d.backlog_issue_key = $1)
                AND c.primary_vendor_id IS NOT NULL
           ) linked ON linked.vendor_id = v.id
          ORDER BY v.vendor_name, v.id`,
        [issueKey]
      ),
      this.database.query(
        `WITH linked_matters AS (
           SELECT m.id, m.matter_code, m.title, m.status, m.target_due_date
             FROM matter_issues mi
             JOIN matters m ON m.id = mi.matter_id
            WHERE mi.backlog_issue_key = $1
         )
         SELECT *
           FROM (
             SELECT 'request:' || lr.id AS id, 'request'::text AS kind,
                    COALESCE(NULLIF(lr.summary,''), lr.backlog_issue_key, '法務依頼') AS title,
                    (lr.deadline AT TIME ZONE 'Asia/Tokyo')::date::text AS due_date,
                    'open'::text AS status
               FROM legal_requests lr
              WHERE lr.backlog_issue_key = $1 AND lr.deadline IS NOT NULL
             UNION ALL
             SELECT 'matter:' || m.id, 'matter',
                    COALESCE(NULLIF(m.matter_code,''), m.title) || ' 案件期限',
                    m.target_due_date::text, m.status::text
               FROM linked_matters m
              WHERE m.target_due_date IS NOT NULL
             UNION ALL
             SELECT 'task:' || t.id, 'task', t.title,
                    (t.due_at AT TIME ZONE 'Asia/Tokyo')::date::text, t.status::text
               FROM matter_tasks t
               JOIN linked_matters m ON m.id = t.matter_id
              WHERE t.due_at IS NOT NULL
                AND t.status IN ('open','in_progress')
             UNION ALL
             SELECT 'document:' || d.id, 'document',
                    COALESCE(NULLIF(d.contract_title,''), d.document_number, d.template_type) || ' 期日',
                    d.due_date::text,
                    COALESCE(d.lifecycle_status,d.contract_status,'active')::text
               FROM documents d
              WHERE (d.issue_key = $1 OR d.backlog_issue_key = $1)
                AND d.due_date IS NOT NULL
                AND d.is_active = true
             UNION ALL
             SELECT 'contract:' || c.id, 'contract',
                    COALESCE(NULLIF(c.contract_title,''), c.document_number, '契約') || ' 契約終了',
                    c.expiration_date::text,
                    COALESCE(c.contract_status,'active')::text
               FROM documents d
               JOIN contracts c ON c.id = d.contract_id
              WHERE (d.issue_key = $1 OR d.backlog_issue_key = $1)
                AND c.expiration_date IS NOT NULL
                AND COALESCE(c.contract_status,'') NOT IN ('cancelled','terminated','expired')
           ) x
          ORDER BY due_date, kind, id`,
        [issueKey]
      )
    ]);
    return {
      ...mapRow(base.rows[0]),
      matters: matters.rows.map((row) => ({
        id: Number(row.id),
        matterCode: row.matter_code ?? null,
        title: String(row.title ?? ""),
        status: String(row.status ?? "open"),
        relation: String(row.relation ?? "related"),
        primary: Boolean(row.is_primary)
      })),
      documents: documents.rows.map((row) => ({
        id: Number(row.id),
        documentNumber: row.document_number ?? null,
        templateType: String(row.template_type ?? ""),
        driveLink: String(row.drive_link ?? ""),
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null
      })),
      contracts: contracts.rows.map((row) => ({
        id: Number(row.id),
        documentNumber: row.document_number ?? null,
        title: String(row.contract_title ?? row.document_number ?? `Contract #${row.id}`),
        contractType: row.contract_type ?? null,
        status: row.contract_status ?? null,
        expirationDate: row.expiration_date ? String(row.expiration_date).slice(0, 10) : null
      })),
      works: works.rows.map((row) => ({
        id: Number(row.id),
        workCode: row.work_code ?? null,
        title: String(row.title ?? `Work #${row.id}`)
      })),
      vendors: vendors.rows.map((row) => ({
        id: Number(row.id),
        vendorCode: row.vendor_code ?? null,
        name: String(row.vendor_name ?? `Vendor #${row.id}`)
      })),
      deadlines: deadlines.rows.map((row) => ({
        id: String(row.id),
        kind: String(row.kind) as LegalRequestDetail["deadlines"][number]["kind"],
        title: String(row.title ?? ""),
        dueDate: String(row.due_date ?? "").slice(0, 10),
        status: String(row.status ?? "open")
      }))
    };
  }

  async linkMatter(requestId: number, matterId: number, primary = false) {
    const requestResult = await this.database.query(
      `SELECT id, backlog_issue_key, summary FROM legal_requests WHERE id = $1`,
      [requestId]
    );
    if (!requestResult.rows[0]) throw new RequestWriteError("REQUEST_NOT_FOUND", "依頼が見つかりません");
    const matterResult = await this.database.query(
      `SELECT id FROM matters WHERE id = $1`,
      [matterId]
    );
    if (!matterResult.rows[0]) throw new RequestWriteError("MATTER_NOT_FOUND", "案件が見つかりません");

    const issueKey = String(requestResult.rows[0].backlog_issue_key);
    const summary = requestResult.rows[0].summary ?? null;
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO matter_issues (matter_id, backlog_issue_key, relation, summary_snapshot)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (matter_id, backlog_issue_key) DO UPDATE SET
           relation = EXCLUDED.relation,
           summary_snapshot = COALESCE(matter_issues.summary_snapshot, EXCLUDED.summary_snapshot)`,
        [matterId, issueKey, primary ? "primary" : "related", summary]
      );
      if (primary) {
        await client.query(
          `UPDATE matters
              SET primary_issue_key = $2, updated_at = now()
            WHERE id = $1`,
          [matterId, issueKey]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return (await this.find(requestId))!;
  }
}

export class RequestWriteError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function mapRow(row: Record<string, any>): LegalRequestRow {
  const matterCount = Number(row.matter_count ?? 0);
  const documentCount = Number(row.document_count ?? 0);
  const legalResponseCount = Number(row.legal_response_count ?? 0);
  const disposition: RequestDisposition =
    legalResponseCount > 0 ? "completed" :
    matterCount > 0 ? "matter_linked" :
    documentCount > 0 ? "document_created" :
    "received";
  return {
    id: Number(row.id),
    issueKey: String(row.backlog_issue_key ?? ""),
    summary: String(row.summary ?? ""),
    contractType: row.contract_type ?? null,
    counterparty: row.counterparty ?? null,
    slackUserId: row.slack_user_id ?? null,
    deadline: row.deadline ? formatTokyoDate(row.deadline) : null,
    notes: row.notes ?? null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    matterCount,
    documentCount,
    legalResponseCount,
    disposition
  };
}

function formatTokyoDate(value: Date | string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(value));
}

export class MemoryRequestRepository implements RequestRepository {
  constructor(private readonly rows: LegalRequestDetail[] = []) {}
  async list(query = "", limit = 200) {
    const keyword = query.trim().toLowerCase();
    return this.rows
      .filter((row) => !keyword || [row.issueKey, row.summary, row.counterparty ?? ""]
        .some((value) => value.toLowerCase().includes(keyword)))
      .slice(0, limit)
      .map(({ matters: _m, documents: _d, contracts: _c, works: _w, vendors: _v, deadlines: _dl, ...row }) => row);
  }
  async find(id: number) {
    return this.rows.find((row) => row.id === id) ?? null;
  }
  async linkMatter(requestId: number, matterId: number, primary = false) {
    const row = this.rows.find((candidate) => candidate.id === requestId);
    if (!row) throw new RequestWriteError("REQUEST_NOT_FOUND", "依頼が見つかりません");
    if (!row.matters.some((matter) => matter.id === matterId)) {
      row.matters.push({
        id: matterId, matterCode: null, title: `Matter ${matterId}`,
        status: "open", relation: primary ? "primary" : "related", primary
      });
      row.matterCount = row.matters.length;
      row.disposition = "matter_linked";
    }
    return row;
  }
}
