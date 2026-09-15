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
          `SELECT scope_type,
                  jsonb_agg(jsonb_build_object('code', code, 'label', label)
                            ORDER BY label) AS values
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
          values: ((s.values as Array<{ code: string | null; label: string }> | null) ?? [])
            .map((v) => ({ code: str(v.code), label: String(v.label) }))
        }))
      };
    } catch (error) { throw translate(error); }
  }

  /**
   * 作品の台帳。作品と原作（Core Logic）の系譜を1回で返す。
   *
   * 一覧は 200 件で切っていたが、台帳は原作ごとに作品を束ねて出すので、
   * 一部だけでは束ね損なう。上限を広く取る。
   */
  async tree(keyword = "", includeArchived = false) {
    try {
      const works = await this.database.query(
        `SELECT w.id, w.work_code, w.title, w.title_kana, w.kind, w.status, w.business_line,
                (w.legacy_id IS NOT NULL) AS legacy, w.merged_into_id,
                (SELECT count(*)::int FROM conditions c
                  WHERE c.work_id = w.id AND c.status <> 'void') AS conditions,
                (SELECT count(*)::int FROM work_parts p WHERE p.work_id = w.id) AS parts
           FROM works w
          WHERE ($1 = '' OR w.title ILIKE '%' || $1 || '%'
                 OR COALESCE(w.work_code,'') ILIKE '%' || $1 || '%'
                 OR COALESCE(w.title_kana,'') ILIKE '%' || $1 || '%')
            AND ($2 OR w.status <> 'archived')
          ORDER BY w.kind = 'source_ip' DESC, w.title
          LIMIT 3000`,
        [keyword.trim(), includeArchived]);
      // 同じ親子が関係の種類違いで2行あることがある（移行元の表が2つ）。
      // 画面は親子だけを見るので1つにまとめる。
      const lineage = await this.database.query(
        "SELECT DISTINCT parent_work_id, child_work_id FROM work_lineage");
      return {
        works: works.rows.map((w) => ({
          id: Number(w.id), workCode: str(w.work_code), title: String(w.title),
          titleKana: str(w.title_kana), kind: String(w.kind), status: String(w.status),
          businessLine: str(w.business_line), legacy: w.legacy === true,
          mergedIntoId: w.merged_into_id === null || w.merged_into_id === undefined ? null : Number(w.merged_into_id),
          conditions: Number(w.conditions ?? 0), parts: Number(w.parts ?? 0)
        })),
        lineage: lineage.rows.map((l) => ({
          parentId: Number(l.parent_work_id), childId: Number(l.child_work_id)
        }))
      };
    } catch (error) { throw translate(error); }
  }

  /** 1作品の中身。編集画面が使う。 */
  async find(workId: number) {
    try {
      const r = await this.database.query(
        `SELECT w.id, w.work_code, w.title, w.title_kana, w.kind, w.status, w.business_line, w.remarks,
                w.copyright_notice, w.third_party_rights,
                (w.legacy_id IS NOT NULL) AS legacy, w.merged_into_id,
                m.work_code AS merged_into_code, m.title AS merged_into_title
           FROM works w LEFT JOIN works m ON m.id = w.merged_into_id
          WHERE w.id = $1`, [workId]);
      const w = r.rows[0] as Record<string, any> | undefined;
      if (!w) return null;
      const [sources, children, parts] = await Promise.all([
        this.database.query(
          // 同じ親子が関係の種類違いで2行あるので DISTINCT。画面に同じ原作が2つ並んでいた。
          `SELECT DISTINCT p.id, p.work_code, p.title, p.kind FROM work_lineage l
             JOIN works p ON p.id = l.parent_work_id WHERE l.child_work_id = $1 ORDER BY p.title`,
          [workId]),
        this.database.query(
          `SELECT DISTINCT c.id, c.work_code, c.title, c.kind FROM work_lineage l
             JOIN works c ON c.id = l.child_work_id WHERE l.parent_work_id = $1 ORDER BY c.title`,
          [workId]),
        this.parts(workId)
      ]);
      const ref = (row: Record<string, any>) => ({
        id: Number(row.id), workCode: str(row.work_code), title: String(row.title), kind: String(row.kind)
      });
      return {
        id: Number(w.id), workCode: str(w.work_code), title: String(w.title),
        titleKana: str(w.title_kana), kind: String(w.kind), status: String(w.status),
        businessLine: str(w.business_line), remarks: str(w.remarks), legacy: w.legacy === true,
        copyrightNotice: str(w.copyright_notice), thirdPartyRights: str(w.third_party_rights),
        mergedInto: w.merged_into_id === null || w.merged_into_id === undefined ? null
          : { id: Number(w.merged_into_id), workCode: str(w.merged_into_code), title: String(w.merged_into_title ?? "") },
        sources: (sources.rows as Array<Record<string, any>>).map(ref),
        children: (children.rows as Array<Record<string, any>>).map(ref),
        parts
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
