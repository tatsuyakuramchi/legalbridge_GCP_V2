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
    const [matters, documents] = await Promise.all([
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
      .map(({ matters: _m, documents: _d, ...row }) => row);
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
