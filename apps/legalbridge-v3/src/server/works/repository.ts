import type { Transactable } from "../core/db.js";
import { dateStr, int, str } from "../core/db.js";
import { translate } from "../core/errors.js";
import type { RightsEnvelope, ScopeType } from "../core/model.js";

export class WorkRepository {
  constructor(private readonly database: Transactable) {}

  async list(keyword = "", limit = 200) {
    try {
      const r = await this.database.query(
        `SELECT id, work_code, title, kind, status FROM works
          WHERE ($1 = '' OR title ILIKE '%' || $1 || '%' OR COALESCE(work_code,'') ILIKE '%' || $1 || '%')
          ORDER BY work_code NULLS LAST, id
          LIMIT $2`,
        [keyword.trim(), Math.min(Math.max(limit, 1), 500)]
      );
      return r.rows.map((w) => ({
        id: Number(w.id), workCode: str(w.work_code), title: String(w.title),
        kind: String(w.kind), status: String(w.status)
      }));
    } catch (error) { throw translate(error); }
  }

  /** 作品の権利包絡。スカラー次元はビュー、範囲次元は積を取るビューから読む。 */
  async envelope(workId: number): Promise<RightsEnvelope | null> {
    try {
      const [scalar, scopes] = await Promise.all([
        this.database.query(
          `SELECT work_id, work_code, title, acquired_count, term_limit, term_limited_by,
                  exclusivity_limit, exclusivity_limited_by, sublicensable, sublicense_limited_by
             FROM v_work_rights_envelope WHERE work_id = $1`, [workId]),
        this.database.query(
          `SELECT scope_type, array_agg(label ORDER BY label) AS labels
             FROM v_work_scope_envelope WHERE work_id = $1 GROUP BY scope_type`, [workId])
      ]);
      const row = scalar.rows[0] as Record<string, any> | undefined;
      if (!row) return null;
      return {
        workId: Number(row.work_id),
        workCode: str(row.work_code),
        title: String(row.title ?? ""),
        acquiredCount: Number(row.acquired_count ?? 0),
        termLimit: dateStr(row.term_limit),
        termLimitedBy: str(row.term_limited_by),
        exclusivityLimit: row.exclusivity_limit ?? null,
        exclusivityLimitedBy: str(row.exclusivity_limited_by),
        sublicensable: row.sublicensable !== false,
        sublicenseLimitedBy: str(row.sublicense_limited_by),
        scopes: scopes.rows.map((s) => ({
          scopeType: s.scope_type as ScopeType,
          labels: (s.labels as string[] | null) ?? []
        }))
      };
    } catch (error) { throw translate(error); }
  }

  async parts(workId: number) {
    const r = await this.database.query(
      `SELECT p.id, p.part_no, p.name, p.part_type, p.royalty_bearing
         FROM work_parts p WHERE p.work_id = $1 ORDER BY p.part_no`, [workId]);
    return r.rows.map((p) => ({
      id: Number(p.id), partNo: int(p.part_no) ?? 0, name: String(p.name),
      partType: String(p.part_type), royaltyBearing: p.royalty_bearing !== false
    }));
  }
}
