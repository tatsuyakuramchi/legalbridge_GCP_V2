import type { DatabasePool } from "../db/pool.js";

export type SearchTarget = "matter" | "document" | "vendor" | "work";
export interface SearchResult {
  id: string; target: SearchTarget; title: string; code: string; description: string;
}
export interface GlobalSearchRepository {
  search(query: string, limitPerType?: number): Promise<SearchResult[]>;
}
export class PgGlobalSearchRepository implements GlobalSearchRepository {
  constructor(private readonly database: DatabasePool) {}
  async search(query: string, limitPerType = 5) {
    const keyword = `%${query.trim()}%`;
    const limit = Math.min(Math.max(limitPerType, 1), 10);
    const [matters, documents, vendors, works] = await Promise.all([
      this.database.query(
        `SELECT id, matter_code, title, counterparty, status FROM matters
          WHERE title ILIKE $1 OR COALESCE(matter_code, '') ILIKE $1
             OR COALESCE(counterparty, '') ILIKE $1 OR COALESCE(primary_issue_key, '') ILIKE $1
          ORDER BY updated_at DESC LIMIT $2`, [keyword, limit]),
      this.database.query(
        `SELECT id, document_number, template_type, issue_key FROM documents
          WHERE COALESCE(document_number, '') ILIKE $1 OR issue_key ILIKE $1 OR template_type ILIKE $1
          ORDER BY created_at DESC NULLS LAST LIMIT $2`, [keyword, limit]),
      this.database.query(
        `SELECT id, vendor_code, vendor_name, entity_type FROM vendors
          WHERE is_active
            AND (vendor_code ILIKE $1 OR vendor_name ILIKE $1
             OR COALESCE(trade_name, '') ILIKE $1 OR COALESCE(pen_name, '') ILIKE $1)
          ORDER BY vendor_name LIMIT $2`, [keyword, limit]),
      this.database.query(
        `(SELECT 'work' AS source, id, work_code AS code, title, work_type AS category
            FROM works WHERE is_active = TRUE AND (work_code ILIKE $1 OR title ILIKE $1))
         UNION ALL
         (SELECT 'source_ip' AS source, id, source_code AS code, title, '原作IP' AS category
            FROM source_ips WHERE is_active = TRUE AND (source_code ILIKE $1 OR title ILIKE $1))
         ORDER BY title LIMIT $2`, [keyword, limit])
    ]);
    return [
      ...matters.rows.map((row) => ({
        id: String(row.id), target: "matter" as const, title: row.title,
        code: row.matter_code ?? `#${row.id}`,
        description: [row.counterparty, row.status].filter(Boolean).join("・")
      })),
      ...documents.rows.map((row) => ({
        id: String(row.id), target: "document" as const,
        title: row.document_number ?? "未発番", code: row.issue_key,
        description: row.template_type
      })),
      ...vendors.rows.map((row) => ({
        id: String(row.id), target: "vendor" as const, title: row.vendor_name,
        code: row.vendor_code, description: row.entity_type ?? ""
      })),
      ...works.rows.map((row) => ({
        id: `${row.source}:${row.id}`, target: "work" as const, title: row.title,
        code: row.code, description: row.category ?? ""
      }))
    ];
  }
}
export class MemoryGlobalSearchRepository implements GlobalSearchRepository {
  constructor(private readonly items: SearchResult[] = []) {}
  async search(query: string, limitPerType = 5) {
    const keyword = query.trim().toLowerCase();
    const counts = new Map<SearchTarget, number>();
    return this.items.filter((item) => {
      if (!`${item.code} ${item.title} ${item.description}`.toLowerCase().includes(keyword)) return false;
      const count = counts.get(item.target) ?? 0;
      if (count >= limitPerType) return false;
      counts.set(item.target, count + 1);
      return true;
    });
  }
}
