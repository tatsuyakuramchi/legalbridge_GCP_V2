import type { Transactable } from "../core/db.js";
import { str } from "../core/db.js";
import { translate } from "../core/errors.js";

/**
 * 移行データの棚卸し。
 *
 * V2 から移した条件と作品（legacy_id あり）を、V3 で使った形跡があるかで
 * 二つに分ける。
 *
 *   使っていない … 実績も文書も支払も計算書も案件リンクも無い。
 *                 作り直すなら、無効化 → 削除で消してよい。
 *   使っている   … どれかがある。消せない。繋ぎ直すか無効化のままにする。
 *
 * 「消してよい」を機械で決めるのではなく、判断の材料（何がいくつ指しているか）
 * を並べる。人が選んで、一括で無効化と削除をかける。
 */
export interface LegacyCondition {
  id: number; conditionNo: string | null; name: string; direction: string; kind: string;
  status: string; pricingModel: string; legacyId: number | null;
  counterparty: string | null; work: string | null; workId: number | null;
  used: { events: number; outRefs: number; documents: number; payments: number;
          statements: number; matters: number; children: number };
  /** 何も指していない。無効化 → 削除で消せる。 */
  unused: boolean;
}

export interface LegacyWork {
  id: number; workCode: string | null; title: string; kind: string; status: string;
  legacyId: number | null; legacyTable: string | null;
  used: { conditions: number; voidConditions: number; children: number; parts: number };
  /** 条件が1本も無い（無効化済みも含めて）。終了 → 削除で消せる。 */
  unused: boolean;
}

export class LegacyCleanupRepository {
  constructor(private readonly database: Transactable) {}

  async conditions(): Promise<LegacyCondition[]> {
    try {
      const r = await this.database.query(
        `SELECT c.id, c.condition_no, c.name, c.direction, c.kind, c.status, c.pricing_model,
                c.legacy_id, p.name AS party_name, w.title AS work_title, c.work_id,
                (SELECT count(*)::int FROM condition_events e WHERE e.condition_id = c.id)     AS events,
                (SELECT count(*)::int FROM condition_events e WHERE e.out_condition_id = c.id) AS out_refs,
                (SELECT count(*)::int FROM document_conditions d WHERE d.condition_id = c.id)  AS documents,
                (SELECT count(*)::int FROM payment_allocations a WHERE a.condition_id = c.id)  AS payments,
                (SELECT count(*)::int FROM statements s WHERE s.condition_id = c.id)
                  + (SELECT count(*)::int FROM statement_lines s WHERE s.condition_id = c.id)  AS statements,
                (SELECT count(*)::int FROM matter_links m
                  WHERE m.target_type = 'condition' AND m.target_ref = c.id::text)             AS matters,
                (SELECT count(*)::int FROM conditions k WHERE k.parent_id = c.id)              AS children
           FROM conditions c
           LEFT JOIN parties p ON p.id = c.counterparty_id
           LEFT JOIN works w ON w.id = c.work_id
          WHERE c.legacy_id IS NOT NULL
          ORDER BY c.condition_no NULLS LAST, c.id`);
      return (r.rows as Array<Record<string, any>>).map((row) => {
        const used = {
          events: Number(row.events ?? 0), outRefs: Number(row.out_refs ?? 0),
          documents: Number(row.documents ?? 0), payments: Number(row.payments ?? 0),
          statements: Number(row.statements ?? 0), matters: Number(row.matters ?? 0),
          children: Number(row.children ?? 0)
        };
        return {
          id: Number(row.id), conditionNo: str(row.condition_no), name: String(row.name),
          direction: String(row.direction), kind: String(row.kind), status: String(row.status),
          pricingModel: String(row.pricing_model), legacyId: row.legacy_id === null ? null : Number(row.legacy_id),
          counterparty: str(row.party_name), work: str(row.work_title),
          workId: row.work_id === null ? null : Number(row.work_id),
          used, unused: Object.values(used).every((n) => n === 0)
        };
      });
    } catch (error) { throw translate(error); }
  }

  async works(): Promise<LegacyWork[]> {
    try {
      const r = await this.database.query(
        `SELECT w.id, w.work_code, w.title, w.kind, w.status, w.legacy_id, w.legacy_table,
                (SELECT count(*)::int FROM conditions c WHERE c.work_id = w.id AND c.status <> 'void') AS conditions,
                (SELECT count(*)::int FROM conditions c WHERE c.work_id = w.id AND c.status = 'void')  AS void_conditions,
                (SELECT count(*)::int FROM work_lineage l WHERE l.parent_work_id = w.id)               AS children,
                (SELECT count(*)::int FROM work_parts p WHERE p.work_id = w.id)                        AS parts
           FROM works w
          WHERE w.legacy_id IS NOT NULL
          ORDER BY w.kind = 'source_ip' DESC, w.title`);
      return (r.rows as Array<Record<string, any>>).map((row) => {
        const used = {
          conditions: Number(row.conditions ?? 0), voidConditions: Number(row.void_conditions ?? 0),
          children: Number(row.children ?? 0), parts: Number(row.parts ?? 0)
        };
        return {
          id: Number(row.id), workCode: str(row.work_code), title: String(row.title),
          kind: String(row.kind), status: String(row.status),
          legacyId: row.legacy_id === null ? null : Number(row.legacy_id),
          legacyTable: str(row.legacy_table),
          used,
          // パートは作品の一部なので、消してよいかの判断には数えない。
          unused: used.conditions === 0 && used.voidConditions === 0 && used.children === 0
        };
      });
    } catch (error) { throw translate(error); }
  }
}
