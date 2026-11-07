import { dateStr, str, type Queryable } from "../core/db.js";
import { translate } from "../core/errors.js";
import { conditionUsageLabel } from "../core/condition-usage.js";
import type { RightsEnvelope } from "../core/model.js";
import { axisOf, buildRightsMatrix, type CellState, type MatrixAxis, type MatrixGrant, type ScopeValue } from "./rights-matrix.js";

/**
 * 作品をまたぐ 許諾地域 × 許諾言語 の一覧（作品台帳 › 地域×言語の一覧）。
 *
 *   行＝作品、列＝許諾言語、マス＝その言語を（選んだ地域で。地域を選ばなければどこかの地域で）覆う許諾。
 *
 * 作品 1 点の表（rights-matrix.ts）を、全作品で同じ行・列にそろえて組み、地域の向きに畳む。
 * 派生作品（言語版など）は元の作品の行にまとめる（作品 1 点の表と同じ）。
 * マスの色は、畳んだ地域のうちいちばん気にすべきもの（ぶつかり → 範囲外 → 独占 → 非独占 → 空き → なし）。
 */

export type WorkCategory = "publishing" | "game" | "other";
export type OverviewShow = "granted" | "issues" | "open" | "all";

export interface OverviewWork {
  id: number;
  title: string;
  workCode: string | null;
  businessLine: string | null;
  /** 作家との条件（in）の利用形態。カテゴリを決めるのに使う。 */
  inUsageTypes: Array<string | null>;
  /** まとめた派生作品の数。 */
  derived: number;
  grants: MatrixGrant[];
  envelope: Pick<RightsEnvelope, "acquiredCount" | "scopes"> | null;
}

export interface OverviewCell {
  language: string;
  state: CellState;
  parties: string[];
  partyIds: number[];
  grantIds: number[];
  /** 許諾している地域の数・空きの地域の数（畳んだ地域のうち）。 */
  grantedRegions: number;
  openRegions: number;
}

export interface OverviewRow {
  work: { id: number; title: string; workCode: string | null; category: WorkCategory; derived: number };
  acquiredKnown: boolean;
  grants: number;
  parties: string[];
  counts: { conflict: number; outside: number; open: number };
  cells: OverviewCell[];
}

export interface RightsOverview {
  today: string;
  includeEnded: boolean;
  region: string | null;
  regions: MatrixAxis[];
  languages: MatrixAxis[];
  rows: OverviewRow[];
  /** 絞り込みの前の作品数と、上限で切ったか。 */
  total: number;
  truncated: boolean;
  counts: { works: number; conflict: number; outside: number; open: number };
  parties: Array<{ id: number; name: string }>;
}

/** 作品のカテゴリ（作品画面の刊行物・製品の言い分け editionFamilyOf と同じ決め方）。 */
export function categoryOf(businessLine: string | null, inUsageTypes: Array<string | null>): WorkCategory {
  const line = String(businessLine ?? "");
  if (/ゲーム|game/i.test(line)) return "game";
  if (/出版|書籍|publish/i.test(line)) return "publishing";
  if (inUsageTypes.some((u) => String(u ?? "").startsWith("pub_"))) return "publishing";
  if (inUsageTypes.some((u) => u === "in_house" || u === "oem")) return "game";
  return "other";
}

const RANK: Record<CellState, number> = { conflict: 5, outside: 4, exclusive: 3, non_exclusive: 2, open: 1, none: 0 };
const ROW_LIMIT = 300;

/** 純関数：作品ごとの許諾と取った範囲から、作品をまたぐ一覧を組む。 */
export function buildOverview(input: {
  today: string;
  includeEnded: boolean;
  works: OverviewWork[];
  region?: string | null;
  q?: string | null;
  category?: WorkCategory | null;
  partyId?: number | null;
  show?: OverviewShow;
}): RightsOverview {
  const q = (input.q ?? "").trim().toLowerCase();
  const show = input.show ?? "granted";
  const isLive = (g: MatrixGrant) => input.includeEnded || g.termEnd === null || g.termEnd >= input.today;

  const picked = input.works
    .map((w) => ({ ...w, category: categoryOf(w.businessLine, w.inUsageTypes) }))
    .filter((w) => !q || w.title.toLowerCase().includes(q) || String(w.workCode ?? "").toLowerCase().includes(q))
    .filter((w) => !input.category || w.category === input.category)
    .filter((w) => !input.partyId || w.grants.some((g) => g.partyId === input.partyId && isLive(g)));

  // 行・列は、絞った作品の許諾と取った範囲に出てくる国・言語。どの作品も同じ行・列にそろえる。
  const scopeLists = (dim: "region" | "language") => picked.flatMap((w) => [
    ...w.grants.filter(isLive).map((g) => (dim === "region" ? g.regions : g.languages)),
    ((w.envelope?.acquiredCount ?? 0) > 0 ? w.envelope?.scopes.find((s) => s.scopeType === dim)?.values ?? [] : [])
      .map((v): ScopeValue => ({ code: v.code, label: v.label }))
  ]);
  const regions = axisOf(scopeLists("region"), "region", "JP");
  const languages = axisOf(scopeLists("language"), "language", "ja");
  const region = input.region && regions.some((r) => r.key === input.region) ? input.region : null;
  const regionKeys = region ? [region] : regions.map((r) => r.key);

  const all: OverviewRow[] = picked.map((w) => {
    const m = buildRightsMatrix({
      work: { id: w.id, title: w.title }, today: input.today, includeEnded: input.includeEnded,
      grants: w.grants, envelope: w.envelope, axes: { regions, languages }
    });
    const byKey = new Map(m.cells.map((c) => [`${c.region}|${c.language}`, c]));
    const grantOf = new Map(m.grants.map((g) => [g.id, g]));
    const cells: OverviewCell[] = languages.map((l) => {
      let state: CellState = "none";
      const ids = new Set<number>();
      let grantedRegions = 0, openRegions = 0;
      for (const r of regionKeys) {
        const c = byKey.get(`${r}|${l.key}`);
        if (!c) continue;
        if (RANK[c.state] > RANK[state]) state = c.state;
        c.grantIds.forEach((id) => ids.add(id));
        if (c.grantIds.length) grantedRegions++;
        if (c.state === "open") openRegions++;
      }
      const gs = [...ids].map((id) => grantOf.get(id)!).filter(Boolean);
      return {
        language: l.key, state,
        parties: [...new Set(gs.map((g) => g.partyName))], partyIds: [...new Set(gs.map((g) => g.partyId))],
        grantIds: [...ids], grantedRegions, openRegions
      };
    });
    return {
      work: { id: w.id, title: w.title, workCode: w.workCode, category: w.category, derived: w.derived },
      acquiredKnown: m.acquired.known,
      grants: m.grants.length,
      parties: [...new Set(m.grants.map((g) => g.partyName))],
      counts: { conflict: m.counts.conflict, outside: m.counts.outside, open: m.counts.open },
      cells
    };
  });

  const shown = all
    .filter((r) => show === "all"
      || (show === "granted" && r.grants > 0)
      || (show === "issues" && r.counts.conflict + r.counts.outside > 0)
      || (show === "open" && r.counts.open > 0))
    .sort((a, b) => (b.counts.conflict + b.counts.outside > 0 ? 1 : 0) - (a.counts.conflict + a.counts.outside > 0 ? 1 : 0)
      || a.work.title.localeCompare(b.work.title, "ja") || a.work.id - b.work.id);

  const parties = new Map<number, string>();
  for (const w of input.works) for (const g of w.grants) if (isLive(g)) parties.set(g.partyId, g.partyName);
  return {
    today: input.today, includeEnded: input.includeEnded, region, regions, languages,
    rows: shown.slice(0, ROW_LIMIT),
    total: shown.length,
    truncated: shown.length > ROW_LIMIT,
    counts: {
      works: shown.length,
      conflict: shown.filter((r) => r.counts.conflict > 0).length,
      outside: shown.filter((r) => r.counts.outside > 0).length,
      open: shown.filter((r) => r.counts.open > 0).length
    },
    parties: [...parties.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "ja"))
  };
}

const tokyoDate = (d: Date) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(d);

export class RightsOverviewService {
  constructor(private readonly database: Queryable, private readonly now: () => Date = () => new Date()) {}

  async overview(opts: {
    includeEnded?: boolean; region?: string | null; q?: string | null; category?: WorkCategory | null;
    partyId?: number | null; show?: OverviewShow;
  } = {}): Promise<RightsOverview> {
    try {
      // 系譜の根（親のいない作品）ごとに、派生作品を含めた木。統合済みの作品は除く。
      const tree = `WITH RECURSIVE tree(root_id, id) AS (
          SELECT w.id, w.id FROM works w
           WHERE w.merged_into_id IS NULL
             AND NOT EXISTS (SELECT 1 FROM work_lineage l WHERE l.child_work_id = w.id)
          UNION
          SELECT t.root_id, l.child_work_id FROM work_lineage l JOIN tree t ON l.parent_work_id = t.id
        )`;
      const grantRows = (await this.database.query(
        `${tree}
         SELECT t.root_id, c.id, c.condition_no, c.name, c.counterparty_id, p.name AS party_name, c.work_id, w.title AS work_title,
                c.usage_type, c.exclusivity, c.term_start, c.term_end, c.status,
                COALESCE((SELECT jsonb_agg(jsonb_build_object('code', sc.code, 'label', sc.label) ORDER BY sc.sort_order, sc.label)
                            FROM condition_scopes sc WHERE sc.condition_id = c.id AND sc.scope_type = 'region'), '[]'::jsonb) AS regions,
                COALESCE((SELECT jsonb_agg(jsonb_build_object('code', sc.code, 'label', sc.label) ORDER BY sc.sort_order, sc.label)
                            FROM condition_scopes sc WHERE sc.condition_id = c.id AND sc.scope_type = 'language'), '[]'::jsonb) AS languages
           FROM tree t
           JOIN conditions c ON c.work_id = t.id
           JOIN parties p ON p.id = c.counterparty_id
           JOIN works w ON w.id = c.work_id
          WHERE c.direction = 'out' AND c.kind = 'license' AND c.status IN ('active', 'scheduled')
          ORDER BY t.root_id, p.name, c.condition_no NULLS LAST, c.id`)).rows as Array<Record<string, any>>;
      // 作品：許諾があるか、作家との利用許諾（in）がある根の作品。
      const workRows = (await this.database.query(
        `${tree}
         SELECT w.id, w.title, w.work_code, w.business_line,
                (SELECT count(*)::int - 1 FROM tree t2 WHERE t2.root_id = w.id) AS derived,
                (SELECT array_agg(DISTINCT c.usage_type) FROM conditions c
                  WHERE c.work_id = w.id AND c.direction = 'in' AND c.status IN ('active', 'scheduled')) AS in_usage
           FROM works w
          WHERE w.id IN (SELECT root_id FROM tree)
            AND (EXISTS (SELECT 1 FROM tree t JOIN conditions c ON c.work_id = t.id
                          WHERE t.root_id = w.id AND c.direction = 'out' AND c.kind = 'license' AND c.status IN ('active', 'scheduled'))
                 OR EXISTS (SELECT 1 FROM conditions c
                             WHERE c.work_id = w.id AND c.direction = 'in' AND c.kind = 'license' AND c.status IN ('active', 'scheduled')))`
      )).rows as Array<Record<string, any>>;
      const ids = workRows.map((w) => Number(w.id));
      const [acq, scopes] = ids.length ? await Promise.all([
        this.database.query("SELECT work_id, acquired_count FROM v_work_rights_envelope WHERE work_id = ANY($1::bigint[])", [ids]),
        this.database.query(
          `SELECT work_id, scope_type, code, label FROM v_work_scope_envelope
            WHERE work_id = ANY($1::bigint[]) AND scope_type IN ('region', 'language') ORDER BY work_id, scope_type, label`, [ids])
      ]) : [{ rows: [] }, { rows: [] }];
      const acquired = new Map((acq.rows as any[]).map((r) => [Number(r.work_id), Number(r.acquired_count ?? 0)]));
      const scopeOf = new Map<number, Array<{ scopeType: "region" | "language"; values: Array<{ code: string | null; label: string }> }>>();
      for (const r of scopes.rows as any[]) {
        const list = scopeOf.get(Number(r.work_id)) ?? [];
        let s = list.find((x) => x.scopeType === r.scope_type);
        if (!s) { s = { scopeType: r.scope_type, values: [] }; list.push(s); }
        s.values.push({ code: str(r.code), label: String(r.label) });
        scopeOf.set(Number(r.work_id), list);
      }
      const scope = (x: unknown): ScopeValue[] =>
        (Array.isArray(x) ? x : []).map((v: any) => ({ code: str(v?.code), label: String(v?.label ?? "") })).filter((v) => v.label);
      const grantsOf = new Map<number, MatrixGrant[]>();
      for (const c of grantRows) {
        const list = grantsOf.get(Number(c.root_id)) ?? [];
        list.push({
          id: Number(c.id), conditionNo: str(c.condition_no), name: String(c.name ?? ""),
          partyId: Number(c.counterparty_id), partyName: String(c.party_name ?? ""),
          workId: Number(c.work_id), workTitle: String(c.work_title ?? ""), usageLabel: conditionUsageLabel(c.usage_type),
          exclusivity: c.exclusivity === "exclusive" || c.exclusivity === "non_exclusive" ? c.exclusivity : null,
          termStart: dateStr(c.term_start), termEnd: dateStr(c.term_end), status: String(c.status),
          regions: scope(c.regions), languages: scope(c.languages)
        });
        grantsOf.set(Number(c.root_id), list);
      }
      const works: OverviewWork[] = workRows.map((w) => ({
        id: Number(w.id), title: String(w.title ?? ""), workCode: str(w.work_code), businessLine: str(w.business_line),
        inUsageTypes: Array.isArray(w.in_usage) ? w.in_usage.map((u: unknown) => str(u)) : [],
        derived: Math.max(0, Number(w.derived ?? 0)),
        grants: grantsOf.get(Number(w.id)) ?? [],
        envelope: { acquiredCount: acquired.get(Number(w.id)) ?? 0, scopes: scopeOf.get(Number(w.id)) ?? [] }
      }));
      return buildOverview({
        today: tokyoDate(this.now()), includeEnded: !!opts.includeEnded, works,
        region: opts.region ?? null, q: opts.q ?? null, category: opts.category ?? null,
        partyId: opts.partyId ?? null, show: opts.show ?? "granted"
      });
    } catch (error) { throw translate(error); }
  }
}
