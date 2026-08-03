import type { DatabasePool } from "../db/pool.js";

// Read-only projection over the shared production condition_lines table.
// Only columns V2 already writes/reads in production are referenced, so this
// stays safe against schema drift and needs no DDL or template change.
export interface ConditionLineRow {
  id: number;
  lineNo: number | null;
  documentId: number | null;
  documentNumber: string | null;
  matterId: number | null;
  templateType: string | null;
  direction: string | null;        // payable / receivable
  flowDirection: string | null;    // in / out
  transactionKind: string | null;
  conditionName: string;
  vendorName: string;
  workTitle: string;
  territory: string | null;
  currency: string | null;
  amountExTax: number | null;
  mgAmount: number | null;
  ratePct: number | null;
  termStart: string | null;
}

// Grant-free rollup over condition_lines only (installments/events are not
// granted to the runtime role, so true consumption is a later, granted slice).
export interface ConditionLineSummaryRow {
  direction: string;   // payable / receivable / unknown
  currency: string;    // JPY etc.
  lineCount: number;
  totalAmount: number; // sum of amount_ex_tax
  totalMg: number;     // sum of mg_amount
}

export interface ConditionLineRepository {
  list(query: string, limit?: number): Promise<ConditionLineRow[]>;
  summary(): Promise<ConditionLineSummaryRow[]>;
}

export class PgConditionLineRepository implements ConditionLineRepository {
  constructor(private readonly database: DatabasePool) {}
  async list(query: string, limit = 300) {
    const keyword = `%${query.trim()}%`;
    const result = await this.database.query(
      `SELECT cl.id, cl.line_no, cl.document_id, cl.direction, cl.flow_direction,
              cl.transaction_kind, cl.condition_name, cl.currency,
              cl.amount_ex_tax, cl.mg_amount, cl.rate_pct, cl.term_start,
              cl.region_territory,
              d.document_number, d.matter_id, d.template_type,
              COALESCE(v.vendor_name, '') AS vendor_name,
              COALESCE(w.title, '')       AS work_title
         FROM condition_lines cl
         LEFT JOIN documents d ON d.id = cl.document_id
         LEFT JOIN vendors v ON v.id = cl.counterparty_vendor_id
         LEFT JOIN works w ON w.id = cl.work_id
        WHERE ($1 = '%%'
               OR cl.condition_name ILIKE $1
               OR COALESCE(d.document_number, '') ILIKE $1
               OR COALESCE(v.vendor_name, '') ILIKE $1
               OR COALESCE(w.title, '') ILIKE $1)
        ORDER BY cl.id DESC
        LIMIT $2`,
      [keyword, Math.min(Math.max(limit, 1), 1000)]
    );
    return result.rows.map(mapRow);
  }

  async summary() {
    const result = await this.database.query(
      `SELECT COALESCE(NULLIF(cl.direction, ''), 'unknown') AS direction,
              COALESCE(NULLIF(cl.currency, ''), 'JPY')      AS currency,
              COUNT(*)::int                                 AS line_count,
              COALESCE(SUM(cl.amount_ex_tax), 0)            AS total_amount,
              COALESCE(SUM(cl.mg_amount), 0)                AS total_mg
         FROM condition_lines cl
        GROUP BY 1, 2
        ORDER BY 1, 2`
    );
    return result.rows.map(mapSummary);
  }
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function mapRow(row: Record<string, any>): ConditionLineRow {
  return {
    id: Number(row.id),
    lineNo: row.line_no === null ? null : Number(row.line_no),
    documentId: row.document_id === null ? null : Number(row.document_id),
    documentNumber: row.document_number ?? null,
    matterId: row.matter_id === null ? null : Number(row.matter_id),
    templateType: row.template_type ?? null,
    direction: row.direction ?? null,
    flowDirection: row.flow_direction ?? null,
    transactionKind: row.transaction_kind ?? null,
    conditionName: String(row.condition_name ?? ""),
    vendorName: String(row.vendor_name ?? ""),
    workTitle: String(row.work_title ?? ""),
    territory: row.region_territory ?? null,
    currency: row.currency ?? null,
    amountExTax: num(row.amount_ex_tax),
    mgAmount: num(row.mg_amount),
    ratePct: num(row.rate_pct),
    termStart: row.term_start ? String(row.term_start).slice(0, 10) : null
  };
}

function mapSummary(row: Record<string, any>): ConditionLineSummaryRow {
  return {
    direction: String(row.direction ?? "unknown"),
    currency: String(row.currency ?? "JPY"),
    lineCount: Number(row.line_count ?? 0),
    totalAmount: num(row.total_amount) ?? 0,
    totalMg: num(row.total_mg) ?? 0
  };
}

export class MemoryConditionLineRepository implements ConditionLineRepository {
  constructor(private readonly rows: ConditionLineRow[] = []) {}
  async list(query: string, limit = 300) {
    const keyword = query.trim().toLowerCase();
    return this.rows
      .filter((row) => !keyword || [row.conditionName, row.documentNumber, row.vendorName, row.workTitle]
        .some((value) => value?.toLowerCase().includes(keyword)))
      .slice(0, limit);
  }
  async summary() {
    const groups = new Map<string, ConditionLineSummaryRow>();
    for (const row of this.rows) {
      const direction = row.direction || "unknown";
      const currency = row.currency || "JPY";
      const key = `${direction}|${currency}`;
      const entry = groups.get(key) ?? { direction, currency, lineCount: 0, totalAmount: 0, totalMg: 0 };
      entry.lineCount += 1;
      entry.totalAmount += row.amountExTax ?? 0;
      entry.totalMg += row.mgAmount ?? 0;
      groups.set(key, entry);
    }
    return [...groups.values()].sort((a, b) =>
      a.direction.localeCompare(b.direction) || a.currency.localeCompare(b.currency));
  }
}
