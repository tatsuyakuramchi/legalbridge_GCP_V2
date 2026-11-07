import { dateStr, int, str, type Queryable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { conditionUsageLabel } from "../core/condition-usage.js";
import type { RightsEnvelope } from "../core/model.js";

/**
 * 作品 › 許諾地域×許諾言語の表（ライセンスマトリクス。docs/v1-v2-remaining-migration-plan.md R4）。
 *
 *   行＝許諾地域、列＝許諾言語、マス＝そこを覆う許諾（OUT 条件）。
 *
 * 地域・言語の行が無い条件はその次元が無制限（全世界・全言語）。条件に出てくる個別の国・言語を
 * 行・列にし、どれにも当たらないところは「その他の地域」「その他の言語」にまとめる
 * （全世界・全言語の許諾と、作者から取った範囲だけがそこを覆う）。
 *
 * マスの状態
 *   conflict … 独占の許諾が、期間の重なるほかの許諾とぶつかっている
 *   outside  … 許諾はあるが、作者から取った範囲（作品の権利包絡）の外
 *   exclusive / non_exclusive … 許諾あり（独占を含むなら exclusive）
 *   open     … 作者から取った範囲の内で、まだ許諾していない（空き）
 *   none     … 取った範囲の外で、許諾も無い（作者の条件が無い作品は「分からない」ので none）
 */

export interface ScopeValue { code: string | null; label: string }

export interface MatrixGrant {
  id: number;
  conditionNo: string | null;
  name: string;
  partyId: number;
  partyName: string;
  workId: number;
  workTitle: string;
  usageLabel: string;
  exclusivity: "exclusive" | "non_exclusive" | null;
  termStart: string | null;
  termEnd: string | null;
  status: string;
  regions: ScopeValue[];
  languages: ScopeValue[];
}

export type CellState = "conflict" | "outside" | "exclusive" | "non_exclusive" | "open" | "none";

export interface MatrixAxis { key: string; label: string; other: boolean }

export interface MatrixCell {
  region: string;
  language: string;
  state: CellState;
  grantIds: number[];
  /** ぶつかっている許諾の組（conflict のとき）。 */
  conflicts: Array<[number, number]>;
}

export interface RightsMatrix {
  work: { id: number; title: string };
  today: string;
  includeEnded: boolean;
  /** 作者から取った範囲。acquired = false なら作者の条件が無く、範囲が分からない。 */
  acquired: { known: boolean; regions: ScopeValue[]; languages: ScopeValue[] };
  regions: MatrixAxis[];
  languages: MatrixAxis[];
  grants: Array<MatrixGrant & { ended: boolean; scheduled: boolean }>;
  cells: MatrixCell[];
  counts: { conflict: number; outside: number; granted: number; open: number };
}

const OTHER_REGION = "__other_region";
const OTHER_LANGUAGE = "__other_language";

const isUniversal = (v: ScopeValue, dim: "region" | "language") => {
  const code = String(v.code ?? "").trim().toUpperCase();
  return dim === "region"
    ? code === "WORLD" || v.label === "全世界"
    : code === "ALL" || v.label === "全言語";
};
/** 行・列の鍵。コードがあればコード（地域は大文字・言語は小文字）、無ければ名前。 */
const keyOf = (v: ScopeValue, dim: "region" | "language") => {
  const code = String(v.code ?? "").trim();
  if (code) return dim === "region" ? code.toUpperCase() : code.toLowerCase();
  return `name:${v.label.trim()}`;
};

/** その次元で、この範囲が鍵を覆うか。範囲が空・全世界（全言語）なら全部を覆う。 */
const covers = (scope: ScopeValue[], key: string, dim: "region" | "language") => {
  if (!scope.length || scope.some((v) => isUniversal(v, dim))) return true;
  if (key === OTHER_REGION || key === OTHER_LANGUAGE) return false;
  return scope.some((v) => keyOf(v, dim) === key);
};

const overlaps = (a: { termStart: string | null; termEnd: string | null }, b: { termStart: string | null; termEnd: string | null }) =>
  (a.termStart === null || b.termEnd === null || a.termStart <= b.termEnd)
  && (b.termStart === null || a.termEnd === null || b.termStart <= a.termEnd);

/** 地域・言語の並び：許諾の多い順、同じなら名前順。日本・日本語は先頭。 */
function axisOf(values: ScopeValue[][], dim: "region" | "language", head: string): MatrixAxis[] {
  const seen = new Map<string, { label: string; n: number }>();
  for (const list of values) {
    for (const v of list) {
      if (isUniversal(v, dim)) continue;
      const key = keyOf(v, dim);
      const hit = seen.get(key);
      if (hit) hit.n += 1; else seen.set(key, { label: v.label, n: 1 });
    }
  }
  const axis = [...seen.entries()]
    .sort(([ka, a], [kb, b]) => Number(kb === head) - Number(ka === head) || b.n - a.n || a.label.localeCompare(b.label, "ja"))
    .map(([key, v]) => ({ key, label: v.label, other: false }));
  axis.push(dim === "region"
    ? { key: OTHER_REGION, label: axis.length ? "その他の地域" : "全世界", other: true }
    : { key: OTHER_LANGUAGE, label: axis.length ? "その他の言語" : "全言語", other: true });
  return axis;
}

/** 純関数：許諾と作者から取った範囲から表を組む。 */
export function buildRightsMatrix(input: {
  work: { id: number; title: string };
  today: string;
  includeEnded: boolean;
  grants: MatrixGrant[];
  envelope: Pick<RightsEnvelope, "acquiredCount" | "scopes"> | null;
}): RightsMatrix {
  const known = !!input.envelope && input.envelope.acquiredCount > 0;
  const scopeOf = (t: "region" | "language") =>
    (input.envelope?.scopes.find((s) => s.scopeType === t)?.values ?? []).map((v) => ({ code: v.code, label: v.label }));
  const acquired = { known, regions: known ? scopeOf("region") : [], languages: known ? scopeOf("language") : [] };

  const grants = input.grants
    .map((g) => ({
      ...g,
      ended: g.termEnd !== null && g.termEnd < input.today,
      scheduled: g.status === "scheduled" || (g.termStart !== null && g.termStart > input.today)
    }))
    .filter((g) => input.includeEnded || !g.ended);

  const regions = axisOf([...grants.map((g) => g.regions), acquired.regions], "region", "JP");
  const languages = axisOf([...grants.map((g) => g.languages), acquired.languages], "language", "ja");

  const cells: MatrixCell[] = [];
  const counts = { conflict: 0, outside: 0, granted: 0, open: 0 };
  for (const r of regions) {
    for (const l of languages) {
      const here = grants.filter((g) => covers(g.regions, r.key, "region") && covers(g.languages, l.key, "language"));
      const inside = known && covers(acquired.regions, r.key, "region") && covers(acquired.languages, l.key, "language");
      // 終わった許諾どうしはぶつからない（表に出すだけ）。
      const live = here.filter((g) => !g.ended);
      const conflicts: Array<[number, number]> = [];
      for (let i = 0; i < live.length; i++) {
        for (let j = i + 1; j < live.length; j++) {
          const a = live[i]!, b = live[j]!;
          if ((a.exclusivity === "exclusive" || b.exclusivity === "exclusive") && a.partyId !== b.partyId && overlaps(a, b)) {
            conflicts.push([a.id, b.id]);
          }
        }
      }
      let state: CellState;
      if (conflicts.length) state = "conflict";
      else if (here.length && known && !inside) state = "outside";
      else if (here.length) state = here.some((g) => g.exclusivity === "exclusive" && !g.ended) ? "exclusive" : "non_exclusive";
      else state = inside ? "open" : "none";
      if (state === "conflict") counts.conflict++;
      else if (state === "outside") counts.outside++;
      else if (state === "open") counts.open++;
      if (here.length) counts.granted++;
      cells.push({ region: r.key, language: l.key, state, grantIds: here.map((g) => g.id), conflicts });
    }
  }
  return { work: input.work, today: input.today, includeEnded: input.includeEnded, acquired, regions, languages, grants, cells, counts };
}

/** 東京の日付（YYYY-MM-DD）。 */
const tokyoDate = (d: Date) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(d);

export class WorkRightsMatrixService {
  constructor(
    private readonly database: Queryable,
    private readonly envelopeOf: (workId: number) => Promise<RightsEnvelope | null>,
    private readonly now: () => Date = () => new Date()
  ) {}

  /**
   * 作品 1 点の表。許諾はこの作品と派生作品（言語版など）の OUT の利用許諾。
   * 作者から取った範囲はこの作品の権利包絡（構成パート全部の積）。
   */
  async forWork(workId: number, includeEnded = false): Promise<RightsMatrix> {
    try {
      const w = (await this.database.query("SELECT id, title FROM works WHERE id = $1", [workId])).rows[0] as Record<string, any> | undefined;
      if (!w) throw new DomainError("NOT_FOUND", "作品が見つかりません");
      const rows = (await this.database.query(
        `WITH RECURSIVE down(id) AS (
           SELECT $1::bigint
           UNION SELECT l.child_work_id FROM work_lineage l JOIN down d ON l.parent_work_id = d.id
         )
         SELECT c.id, c.condition_no, c.name, c.counterparty_id, p.name AS party_name, c.work_id, w.title AS work_title,
                c.usage_type, c.exclusivity, c.term_start, c.term_end, c.status,
                COALESCE((SELECT jsonb_agg(jsonb_build_object('code', sc.code, 'label', sc.label) ORDER BY sc.sort_order, sc.label)
                            FROM condition_scopes sc WHERE sc.condition_id = c.id AND sc.scope_type = 'region'), '[]'::jsonb) AS regions,
                COALESCE((SELECT jsonb_agg(jsonb_build_object('code', sc.code, 'label', sc.label) ORDER BY sc.sort_order, sc.label)
                            FROM condition_scopes sc WHERE sc.condition_id = c.id AND sc.scope_type = 'language'), '[]'::jsonb) AS languages
           FROM conditions c
           JOIN parties p ON p.id = c.counterparty_id
           JOIN works w ON w.id = c.work_id
          WHERE c.work_id IN (SELECT id FROM down)
            AND c.direction = 'out' AND c.kind = 'license' AND c.status IN ('active', 'scheduled')
          ORDER BY p.name, c.condition_no NULLS LAST, c.id`, [workId])).rows as Array<Record<string, any>>;
      const scope = (x: unknown): ScopeValue[] =>
        (Array.isArray(x) ? x : []).map((v: any) => ({ code: str(v?.code), label: String(v?.label ?? "") })).filter((v) => v.label);
      const grants: MatrixGrant[] = rows.map((c) => ({
        id: Number(c.id), conditionNo: str(c.condition_no), name: String(c.name ?? ""),
        partyId: Number(c.counterparty_id), partyName: String(c.party_name ?? ""),
        workId: Number(c.work_id), workTitle: String(c.work_title ?? ""),
        usageLabel: conditionUsageLabel(c.usage_type),
        exclusivity: c.exclusivity === "exclusive" || c.exclusivity === "non_exclusive" ? c.exclusivity : null,
        termStart: dateStr(c.term_start), termEnd: dateStr(c.term_end), status: String(c.status),
        regions: scope(c.regions), languages: scope(c.languages)
      }));
      return buildRightsMatrix({
        work: { id: int(w.id) ?? workId, title: String(w.title ?? "") },
        today: tokyoDate(this.now()), includeEnded, grants,
        envelope: await this.envelopeOf(workId)
      });
    } catch (error) { throw translate(error); }
  }
}
