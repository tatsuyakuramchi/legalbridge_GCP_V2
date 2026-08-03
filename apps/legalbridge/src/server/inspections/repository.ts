import type { DatabasePool } from "../db/pool.js";

// Grant-free purchase-order worklist over the documents table (SELECT granted).
// "検収待ち" here is document-level: a 発注書 (purchase_order) that has no
// inspection_certificate in the same matter or issue. Per-line 検収率 / 納期
// needs condition_events (not granted) and is a later, granted slice.
export interface PendingInspectionRow {
  id: number;
  documentNumber: string | null;
  issueKey: string | null;
  matterId: number | null;
  matterCode: string | null;
  matterTitle: string | null;
  createdAt: string | null;
  hasInspection: boolean;
}

export interface PendingInspectionRepository {
  list(query: string, onlyPending: boolean, limit?: number): Promise<PendingInspectionRow[]>;
}

const PO = "purchase_order";
const IC = "inspection_certificate";

export class PgPendingInspectionRepository implements PendingInspectionRepository {
  constructor(private readonly database: DatabasePool) {}
  async list(query: string, onlyPending: boolean, limit = 300) {
    const keyword = `%${query.trim()}%`;
    const result = await this.database.query(
      `SELECT po.id, po.document_number, po.issue_key, po.matter_id, po.created_at,
              m.matter_code, m.title AS matter_title,
              EXISTS (
                SELECT 1 FROM documents ic
                 WHERE ic.template_type = $2
                   AND ((po.matter_id IS NOT NULL AND ic.matter_id = po.matter_id)
                        OR (COALESCE(po.issue_key, '') <> '' AND ic.issue_key = po.issue_key))
              ) AS has_inspection
         FROM documents po
         LEFT JOIN matters m ON m.id = po.matter_id
        WHERE po.template_type = $1
          AND ($3 = '%%'
               OR COALESCE(po.document_number, '') ILIKE $3
               OR COALESCE(po.issue_key, '') ILIKE $3
               OR COALESCE(m.title, '') ILIKE $3
               OR COALESCE(m.matter_code, '') ILIKE $3)
        ORDER BY po.created_at DESC NULLS LAST, po.id DESC
        LIMIT $4`,
      [PO, IC, keyword, Math.min(Math.max(limit, 1), 1000)]
    );
    const rows = result.rows.map(mapRow);
    return onlyPending ? rows.filter((row) => !row.hasInspection) : rows;
  }
}

function mapRow(row: Record<string, any>): PendingInspectionRow {
  return {
    id: Number(row.id),
    documentNumber: row.document_number ?? null,
    issueKey: row.issue_key ?? null,
    matterId: row.matter_id === null ? null : Number(row.matter_id),
    matterCode: row.matter_code ?? null,
    matterTitle: row.matter_title ?? null,
    createdAt: row.created_at ? new Date(String(row.created_at)).toISOString() : null,
    hasInspection: Boolean(row.has_inspection)
  };
}

export class MemoryPendingInspectionRepository implements PendingInspectionRepository {
  constructor(private readonly rows: PendingInspectionRow[] = []) {}
  async list(query: string, onlyPending: boolean, limit = 300) {
    const keyword = query.trim().toLowerCase();
    return this.rows
      .filter((row) => !keyword || [row.documentNumber, row.issueKey, row.matterTitle, row.matterCode]
        .some((value) => value?.toLowerCase().includes(keyword)))
      .filter((row) => !onlyPending || !row.hasInspection)
      .slice(0, limit);
  }
}
