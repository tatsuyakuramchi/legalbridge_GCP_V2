import { str, type Queryable } from "../core/db.js";
import { translate } from "../core/errors.js";

/**
 * 監査 › 条件の点検 › 作品の重複・原作の整理（docs/work-editions.md §8）。
 *
 * 原作と作品は表裏一体で、名前だけが違うことがある。原作名は作品の項目（works.source_title）で持ち、
 * 原作を別の作品として立てるのは、1 つの原作を複数の作品に使うときだけにする。
 *   作品の重複 … 名前（全角・半角・空白・記号の違いは同じとみなす）が同じ生きた作品の組。まとめる（統合）。
 *   原作の整理 … 種別 原作の作品。子の作品が 1 つなら作品に畳む（原作名に）、2 つ以上なら原作名を写す。
 */

export interface WorkCheck {
  id: number; code: string | null; title: string; kind: string; legacy: boolean; sourceTitle: string | null;
  /** 作者との許諾（IN）・取引先への許諾（OUT）・そのほかの条件の数（無効を除く）。 */
  inConditions: number; outConditions: number; otherConditions: number;
  /** 決定した文書の数（条件に繋がるもの）。 */
  documents: number;
  /** 刊行物・製品の数（193 の前は 0）。 */
  editions: number;
  parentIds: number[]; childIds: number[];
}
export interface WorkStructureCheck {
  duplicates: Array<{ key: string; works: WorkCheck[]; keepId: number; linked: boolean }>;
  sources: Array<{ work: WorkCheck; children: Array<{ id: number; code: string | null; title: string; sourceTitle: string | null }> }>;
}

/** 作品名の表記ゆれを畳む（imports/similar-work.ts の SQL と同じ規則）。 */
export const normalizeTitle = (title: string) =>
  title.normalize("NFKC").replace(/[\s・･\-－‐ー―:：!！?？()（）「」『』【】〈〉《》.,，、。/／~〜]/g, "").toLowerCase();

/** 残す側の目安：決定した文書の多い方、条件の多い方、刊行物の多い方、移行データでない方、古い方（純粋関数）。 */
export function keepOf(works: WorkCheck[]): number {
  const score = (w: WorkCheck) => [w.documents, w.inConditions + w.outConditions + w.otherConditions, w.editions, w.legacy ? 0 : 1, -w.id];
  return [...works].sort((a, b) => {
    const x = score(a), y = score(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i];
    return 0;
  })[0].id;
}

/** 同じ名前の組（純粋関数）。2 つ以上あるものだけ。 */
export function duplicateWorkGroups(works: WorkCheck[]): WorkStructureCheck["duplicates"] {
  const groups = new Map<string, WorkCheck[]>();
  for (const w of works) {
    const k = normalizeTitle(w.title);
    if (!k) continue;
    groups.set(k, [...(groups.get(k) ?? []), w]);
  }
  return [...groups.entries()].filter(([, list]) => list.length > 1).map(([key, list]) => {
    const ids = new Set(list.map((w) => w.id));
    const linked = list.some((w) => w.parentIds.some((p) => ids.has(p)) || w.childIds.some((c) => ids.has(c)));
    return { key, works: list, keepId: keepOf(list), linked };
  }).sort((a, b) => a.works[0].title.localeCompare(b.works[0].title, "ja"));
}

export class WorkStructureCheckService {
  constructor(private readonly database: Queryable) {}

  async run(): Promise<WorkStructureCheck> {
    const q = this.database;
    try {
      const rows = (await q.query(
        `SELECT w.id, w.work_code, w.title, w.kind, (w.legacy_id IS NOT NULL) AS legacy, to_jsonb(w) ->> 'source_title' AS source_title,
                (SELECT count(*)::int FROM conditions c WHERE c.work_id = w.id AND c.status <> 'void' AND c.direction = 'in' AND c.kind = 'license') AS in_c,
                (SELECT count(*)::int FROM conditions c WHERE c.work_id = w.id AND c.status <> 'void' AND c.direction = 'out') AS out_c,
                (SELECT count(*)::int FROM conditions c WHERE c.work_id = w.id AND c.status <> 'void'
                    AND NOT (c.direction = 'out' OR (c.direction = 'in' AND c.kind = 'license'))) AS other_c,
                (SELECT count(DISTINCT d.id)::int FROM conditions c JOIN document_conditions dc ON dc.condition_id = c.id
                   JOIN documents d ON d.id = dc.document_id AND d.status = 'issued' WHERE c.work_id = w.id) AS docs,
                (SELECT array_agg(DISTINCT l.parent_work_id) FROM work_lineage l WHERE l.child_work_id = w.id) AS parents,
                (SELECT array_agg(DISTINCT l.child_work_id) FROM work_lineage l
                   JOIN works cw ON cw.id = l.child_work_id AND cw.status <> 'archived' WHERE l.parent_work_id = w.id) AS children
           FROM works w
          WHERE w.status <> 'archived' AND w.merged_into_id IS NULL
          ORDER BY w.title, w.id`)).rows as Array<Record<string, any>>;
      // 刊行物の数。193 の前の DB では 0。
      const editions = new Map<number, number>();
      try {
        for (const e of (await q.query(
          "SELECT work_id, count(*)::int AS n FROM work_editions WHERE status = 'active' GROUP BY work_id")).rows as Array<{ work_id: number; n: number }>) {
          editions.set(Number(e.work_id), Number(e.n));
        }
      } catch (error) { if ((error as { code?: string })?.code !== "42P01") throw error; }
      const ids = (xs: unknown) => (Array.isArray(xs) ? xs.map(Number).filter((n) => Number.isFinite(n)) : []);
      const works: WorkCheck[] = rows.map((r) => ({
        id: Number(r.id), code: str(r.work_code), title: String(r.title ?? ""), kind: String(r.kind ?? "own"),
        legacy: r.legacy === true, sourceTitle: str(r.source_title),
        inConditions: Number(r.in_c ?? 0), outConditions: Number(r.out_c ?? 0), otherConditions: Number(r.other_c ?? 0),
        documents: Number(r.docs ?? 0), editions: editions.get(Number(r.id)) ?? 0,
        parentIds: ids(r.parents), childIds: ids(r.children)
      }));
      const byId = new Map(works.map((w) => [w.id, w]));
      const sources = works.filter((w) => w.kind === "source_ip").map((w) => ({
        work: w,
        children: w.childIds.map((id) => byId.get(id)).filter((c): c is WorkCheck => Boolean(c))
          .map((c) => ({ id: c.id, code: c.code, title: c.title, sourceTitle: c.sourceTitle }))
      }));
      return { duplicates: duplicateWorkGroups(works), sources };
    } catch (error) { throw translate(error); }
  }
}
