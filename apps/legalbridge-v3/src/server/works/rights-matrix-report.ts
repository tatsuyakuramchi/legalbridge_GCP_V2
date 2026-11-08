import { str, type Queryable } from "../core/db.js";
import { translate } from "../core/errors.js";
import { renderDocumentHtml } from "../documents/render.js";
import type { CellState, MatrixGrant, RightsMatrix, ScopeValue } from "./rights-matrix.js";
import type { WorkRightsMatrixService } from "./rights-matrix.js";
import type { OverviewShow, RightsOverview, RightsOverviewService, WorkCategory } from "./rights-matrix-overview.js";
import { RIGHTS_MATRIX_REPORT_TEMPLATE_HTML, RIGHTS_MATRIX_REPORT_TEMPLATE_KEY } from "./rights-matrix-report-template.js";

/**
 * 許諾地域・許諾言語レポート（rights_matrix_report）。
 *
 * 画面の「地域×言語」（作品 1 点 rights-matrix.ts／作品をまたぐ一覧 rights-matrix-overview.ts）と
 * 同じ集計を、紙（HTML・PDF）に落とす。ここは集計をやり直さず、画面が受け取るのと同じ表を
 * ひな形の値に組み替えるだけ。ひな形は infra/v3/templates/rights_matrix_report.html。
 *
 * 読むだけで、何も書かない（番号も振らない。支払報告書 paydocs/payment-report-service.ts と同じ）。
 */

export const STATE_LABELS: Record<CellState, string> = {
  conflict: "独占がぶつかっている", outside: "取った範囲の外で許諾", exclusive: "独占で許諾",
  non_exclusive: "非独占で許諾", open: "空き（取った範囲の内・未許諾）", none: "取っていない・許諾なし"
};
/** マスに刷る短い印。色が出ない紙でも読めるように文字で。 */
export const STATE_MARKS: Record<CellState, string> = {
  conflict: "✕ ぶつかり", outside: "△ 範囲外", exclusive: "◉ 独占", non_exclusive: "○ 非独占", open: "空き", none: "—"
};
const LEGEND_ORDER: CellState[] = ["exclusive", "non_exclusive", "open", "conflict", "outside", "none"];
const CATEGORY_LABELS: Record<WorkCategory, string> = { publishing: "出版", game: "ボードゲーム等", other: "その他" };
const SHOW_LABELS: Record<OverviewShow, string> = {
  granted: "許諾のある作品", issues: "ぶつかり・範囲外のある作品", open: "空きのある作品", all: "すべての作品"
};
/** マスに名前を出す取引先の数。それより多ければ「ほか n」。 */
const NAMES_PER_CELL = 3;

export interface ReportCell {
  state: CellState; mark: string; names: string[]; more: number; dim: boolean;
  /** 作品をまたぐ一覧で、畳んだ地域のうち空きの地域の数（地域を選ばないとき。空きのマスそのものには出さない）。 */
  openRegions: number;
}
export interface ReportGrant {
  index: number; partyName: string; conditionNo: string; name: string;
  /** 派生作品の許諾のときだけ、その作品名。表の作品そのものなら null。 */
  workTitle: string | null;
  usageLabel: string; exclText: string; termText: string; flag: string | null;
  regionsText: string; languagesText: string;
}
export interface ReportIssue { kind: "conflict" | "outside"; place: string; text: string }

export interface ReportExtra {
  company: Record<string, unknown>;
  documentDate: string;
  remarks?: string | null;
  docNo?: string | null;
}

export const scopeText = (xs: ScopeValue[], all: string) => (xs.length ? xs.map((x) => x.label).join("・") : all);
export const termText = (g: Pick<MatrixGrant, "termStart" | "termEnd">) =>
  !g.termStart && !g.termEnd ? "期間の定めなし" : `${g.termStart ?? "—"} 〜 ${g.termEnd ?? "定めなし"}`;
export const exclText = (e: MatrixGrant["exclusivity"]) =>
  e === "exclusive" ? "独占" : e === "non_exclusive" ? "非独占" : "定めなし";

const legend = () => LEGEND_ORDER.map((state) => ({ state, mark: STATE_MARKS[state], label: STATE_LABELS[state] }));

const companyValues = (c: Record<string, unknown>) => ({
  COMPANY_NAME: String(c.name ?? ""), COMPANY_ADDRESS: String(c.address ?? ""),
  COMPANY_POSTAL_CODE: String(c.postalCode ?? ""), COMPANY_TEL: String(c.tel ?? "")
});

const cellOf = (state: CellState, names: string[], dim: boolean, openRegions = 0): ReportCell => ({
  state, mark: STATE_MARKS[state],
  names: names.slice(0, NAMES_PER_CELL), more: Math.max(0, names.length - NAMES_PER_CELL),
  dim, openRegions
});

/**
 * 作品 1 点のレポートの値。partyId を渡すと、その取引先が覆っていないマスを薄く出し、
 * 許諾の一覧をその取引先に絞る（画面の「取引先で絞る」と同じ）。
 */
export function workReportValues(m: RightsMatrix, extra: ReportExtra & { partyId?: number | null }): Record<string, unknown> {
  const byId = new Map(m.grants.map((g) => [g.id, g]));
  const partyId = extra.partyId ?? null;
  const partyName = partyId === null ? null : (m.grants.find((g) => g.partyId === partyId)?.partyName ?? `取引先 #${partyId}`);
  const regionLabel = (k: string) => m.regions.find((r) => r.key === k)?.label ?? k;
  const languageLabel = (k: string) => m.languages.find((l) => l.key === k)?.label ?? k;
  const byKey = new Map(m.cells.map((c) => [`${c.region}|${c.language}`, c]));

  const rows = m.regions.map((r) => ({
    label: r.label, other: r.other,
    cells: m.languages.map((l) => {
      const c = byKey.get(`${r.key}|${l.key}`);
      if (!c) return cellOf("none", [], false);
      const gs = c.grantIds.map((id) => byId.get(id)).filter((g): g is RightsMatrix["grants"][number] => !!g);
      const names = [...new Set(gs.map((g) => g.partyName))];
      const dim = partyId !== null && !gs.some((g) => g.partyId === partyId);
      return cellOf(c.state, names, dim);
    })
  }));

  const issues: ReportIssue[] = [];
  for (const c of m.cells) {
    const place = `${regionLabel(c.region)} × ${languageLabel(c.language)}`;
    for (const [a, b] of c.conflicts) {
      const ga = byId.get(a), gb = byId.get(b);
      if (!ga || !gb) continue;
      issues.push({
        kind: "conflict", place,
        text: `${ga.partyName}（${exclText(ga.exclusivity)}・${termText(ga)}）と ${gb.partyName}（${exclText(gb.exclusivity)}・${termText(gb)}）の期間が重なっています`
      });
    }
    if (c.state === "outside") {
      const names = [...new Set(c.grantIds.map((id) => byId.get(id)?.partyName).filter((n): n is string => !!n))];
      issues.push({ kind: "outside", place, text: `作者から取った範囲の外で許諾しています（${names.join("・")}）` });
    }
  }

  const listed = partyId === null ? m.grants : m.grants.filter((g) => g.partyId === partyId);
  const grants: ReportGrant[] = listed.map((g, i) => ({
    index: i + 1, partyName: g.partyName, conditionNo: g.conditionNo ?? `#${g.id}`, name: g.name,
    workTitle: g.workId === m.work.id ? null : g.workTitle,
    usageLabel: g.usageLabel, exclText: exclText(g.exclusivity), termText: termText(g),
    flag: g.ended ? "終了" : g.scheduled ? "予定" : null,
    regionsText: scopeText(g.regions, "全世界"), languagesText: scopeText(g.languages, "全言語")
  }));
  const derived = new Set(m.grants.filter((g) => g.workId !== m.work.id).map((g) => g.workId)).size;

  return {
    isWork: true,
    SUBTITLE: `作品：${m.work.title}`,
    DOC_NO: extra.docNo ?? "",
    today: m.today, documentDate: extra.documentDate,
    ...companyValues(extra.company),
    includeEnded: m.includeEnded,
    partyFilter: partyName,
    work: { id: m.work.id, title: m.work.title, derivedNote: derived ? `派生作品 ${derived} 点（言語版など）の許諾を含む` : null },
    acquired: {
      known: m.acquired.known,
      regions: scopeText(m.acquired.regions, "全世界"), languages: scopeText(m.acquired.languages, "全言語")
    },
    summary: {
      grants: m.grants.length, parties: new Set(m.grants.map((g) => g.partyId)).size,
      cells: m.cells.length, granted: m.counts.granted, open: m.counts.open,
      conflict: m.counts.conflict, outside: m.counts.outside
    },
    issues,
    languages: m.languages.map((l) => ({ label: l.label, other: l.other })),
    rows: m.grants.length === 0 && !m.acquired.known ? [] : rows,
    legend: legend(),
    grants,
    remarks: extra.remarks ?? ""
  };
}

/** 作品をまたぐ一覧のレポートの値。絞り込み（地域・題名・カテゴリ・取引先・出す作品）は一覧の結果に既に効いている。 */
export function overviewReportValues(o: RightsOverview, extra: ReportExtra & {
  q?: string | null; category?: WorkCategory | null; partyId?: number | null; show?: OverviewShow;
}): Record<string, unknown> {
  const regionLabel = o.region ? (o.regions.find((r) => r.key === o.region)?.label ?? o.region) : null;
  const partyId = extra.partyId ?? null;
  const partyName = partyId === null ? null : (o.parties.find((p) => p.id === partyId)?.name ?? `取引先 #${partyId}`);
  const filters: Array<{ label: string; value: string }> = [
    { label: "地域", value: regionLabel ?? "すべての地域（畳む）" },
    { label: "出す作品", value: SHOW_LABELS[extra.show ?? "granted"] }
  ];
  if (extra.q?.trim()) filters.push({ label: "題名・コード", value: extra.q.trim() });
  if (extra.category) filters.push({ label: "カテゴリ", value: CATEGORY_LABELS[extra.category] });
  if (partyName) filters.push({ label: "取引先", value: partyName });
  filters.push({ label: "終わった許諾", value: o.includeEnded ? "含む" : "含まない" });

  const rows = o.rows.map((r) => ({
    title: r.work.title, workCode: r.work.workCode, categoryLabel: CATEGORY_LABELS[r.work.category],
    derived: r.work.derived, acquiredKnown: r.acquiredKnown,
    conflict: r.counts.conflict > 0, outside: r.counts.outside > 0,
    cells: r.cells.map((c) => cellOf(
      c.state, c.parties, partyId !== null && !c.partyIds.includes(partyId),
      !o.region && c.state !== "open" ? c.openRegions : 0
    ))
  }));

  return {
    isWork: false,
    SUBTITLE: regionLabel ? `作品をまたぐ一覧（地域：${regionLabel}）` : "作品をまたぐ一覧（全地域）",
    DOC_NO: extra.docNo ?? "",
    today: o.today, documentDate: extra.documentDate,
    ...companyValues(extra.company),
    includeEnded: o.includeEnded,
    regionLabel,
    filters,
    summary: {
      works: o.total, shown: o.rows.length, truncated: o.truncated,
      conflict: o.counts.conflict, outside: o.counts.outside, open: o.counts.open
    },
    languages: o.languages.map((l) => ({ label: l.label, other: l.other })),
    rows,
    legend: legend(),
    remarks: extra.remarks ?? ""
  };
}

/** ファイル名に使えない文字を落とす（Content-Disposition の filename* 用）。 */
export const fileSafe = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 60) || "report";

const tokyoDate = (d: Date) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(d);

export class RightsMatrixReportService {
  constructor(
    private readonly database: Queryable,
    private readonly matrix: WorkRightsMatrixService,
    private readonly overview: RightsOverviewService,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** ひな形の本文。DB に登録済み（204）なら現行版、無ければ既定の本文。 */
  async templateSource(): Promise<string> {
    try {
      const r = await this.database.query(
        `SELECT v.html_source FROM document_templates t
           JOIN document_template_versions v ON v.id = t.current_version_id
          WHERE t.template_key = $1 AND t.is_active`, [RIGHTS_MATRIX_REPORT_TEMPLATE_KEY]);
      const html = str((r.rows[0] as { html_source?: unknown } | undefined)?.html_source);
      return html ?? RIGHTS_MATRIX_REPORT_TEMPLATE_HTML;
    } catch {
      return RIGHTS_MATRIX_REPORT_TEMPLATE_HTML;
    }
  }

  /** 作品 1 点。 */
  async renderWork(workId: number, opts: { includeEnded?: boolean; partyId?: number | null; remarks?: string | null } = {})
    : Promise<{ html: string; matrix: RightsMatrix }> {
    try {
      const matrix = await this.matrix.forWork(workId, !!opts.includeEnded);
      const values = workReportValues(matrix, {
        company: await this.company(), documentDate: tokyoDate(this.now()),
        remarks: opts.remarks ?? null, partyId: opts.partyId ?? null
      });
      return { html: renderDocumentHtml(await this.templateSource(), values), matrix };
    } catch (error) { throw translate(error); }
  }

  /** 作品をまたぐ一覧。絞り込みは画面の一覧と同じ引数。 */
  async renderOverview(opts: {
    includeEnded?: boolean; region?: string | null; q?: string | null; category?: WorkCategory | null;
    partyId?: number | null; show?: OverviewShow; remarks?: string | null;
  } = {}): Promise<{ html: string; overview: RightsOverview }> {
    try {
      const overview = await this.overview.overview({
        includeEnded: opts.includeEnded, region: opts.region, q: opts.q, category: opts.category,
        partyId: opts.partyId, show: opts.show
      });
      const values = overviewReportValues(overview, {
        company: await this.company(), documentDate: tokyoDate(this.now()), remarks: opts.remarks ?? null,
        q: opts.q, category: opts.category, partyId: opts.partyId, show: opts.show ?? "granted"
      });
      return { html: renderDocumentHtml(await this.templateSource(), values), overview };
    } catch (error) { throw translate(error); }
  }

  private async company(): Promise<Record<string, unknown>> {
    try {
      const r = await this.database.query("SELECT value FROM settings WHERE key = 'company_profile'");
      const value = (r.rows[0] as { value?: Record<string, unknown> } | undefined)?.value;
      return (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    } catch { return {}; }
  }
}
