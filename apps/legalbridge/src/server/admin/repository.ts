import type { DatabasePool } from "../db/pool.js";
export interface AdminOverview {
  counts: Record<string, number>;
  activity: { latestDocumentAt: string | null; latestMatterAt: string | null };
}
export interface AdminRepository { overview(): Promise<AdminOverview>; }
export class PgAdminRepository implements AdminRepository {
  constructor(private readonly database: DatabasePool) {}
  async overview() {
    const result = await this.database.query(
      `SELECT
        (SELECT COUNT(*)::int FROM document_templates WHERE is_active = TRUE AND kind = 'document') AS templates,
        (SELECT COUNT(*)::int FROM document_templates WHERE is_active = TRUE AND kind = 'partial') AS partials,
        (SELECT COUNT(*)::int FROM documents) AS documents,
        (SELECT COUNT(*)::int FROM matters) AS matters,
        (SELECT COUNT(*)::int FROM vendors) AS vendors,
        (SELECT COUNT(*)::int FROM staff) AS staff,
        ((SELECT COUNT(*)::int FROM works WHERE is_active = TRUE)
          + (SELECT COUNT(*)::int FROM source_ips WHERE is_active = TRUE)) AS works,
        (SELECT COUNT(*)::int FROM condition_lines) AS conditions,
        (SELECT MAX(created_at) FROM documents) AS latest_document_at,
        (SELECT MAX(updated_at) FROM matters) AS latest_matter_at`
    );
    const row = result.rows[0];
    return {
      counts: {
        templates: Number(row.templates), partials: Number(row.partials),
        documents: Number(row.documents), matters: Number(row.matters),
        vendors: Number(row.vendors), staff: Number(row.staff),
        works: Number(row.works), conditions: Number(row.conditions)
      },
      activity: {
        latestDocumentAt: iso(row.latest_document_at),
        latestMatterAt: iso(row.latest_matter_at)
      }
    };
  }
}
export class MemoryAdminRepository implements AdminRepository {
  constructor(private readonly data: AdminOverview = {
    counts: { templates: 0, partials: 0, documents: 0, matters: 0, vendors: 0, staff: 0, works: 0, conditions: 0 },
    activity: { latestDocumentAt: null, latestMatterAt: null }
  }) {}
  async overview() { return this.data; }
}
function iso(value: unknown) { return value ? new Date(String(value)).toISOString() : null; }
