import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildRightsMatrix, type MatrixGrant } from "./rights-matrix.js";
import { buildOverview, type OverviewWork } from "./rights-matrix-overview.js";
import { fileSafe, overviewReportValues, workReportValues } from "./rights-matrix-report.js";
import { RIGHTS_MATRIX_REPORT_TEMPLATE_HTML } from "./rights-matrix-report-template.js";
import { renderDocumentHtml } from "../documents/render.js";

const JP = { code: "JP", label: "日本" };
const US = { code: "US", label: "アメリカ合衆国" };
const JA = { code: "ja", label: "日本語" };
const EN = { code: "en", label: "英語" };
const PT = { code: "pt", label: "ポルトガル語" };

const grant = (over: Partial<MatrixGrant> & { id: number }): MatrixGrant => ({
  conditionNo: `C-${over.id}`, name: "許諾", partyId: over.id, partyName: `相手${over.id}`, workId: 1, workTitle: "作品",
  usageLabel: "再許諾", exclusivity: "non_exclusive", termStart: "2026-01-01", termEnd: "2028-12-31", status: "active",
  regions: [], languages: [], ...over
});
const envelope = (regions: typeof JP[], languages: typeof JA[]) => ({
  acquiredCount: 1,
  scopes: [{ scopeType: "region" as const, values: regions }, { scopeType: "language" as const, values: languages }]
});
const company = { name: "株式会社テスト", address: "東京都千代田区1-1" };

const matrix = () => buildRightsMatrix({
  work: { id: 1, title: "星降る夜のミュゼ" }, today: "2026-11-08", includeEnded: false,
  envelope: envelope([JP, US], [JA, EN]),
  grants: [
    grant({ id: 1, partyName: "A社", regions: [JP], languages: [JA], exclusivity: "exclusive" }),
    grant({ id: 2, partyName: "B社", regions: [JP], languages: [JA], exclusivity: "non_exclusive" }),
    grant({ id: 3, partyName: "C社", regions: [US], languages: [PT], workId: 9, workTitle: "星降る夜のミュゼ（英語版）" }),
    grant({ id: 4, partyName: "D社", regions: [US], languages: [EN], termStart: "2027-01-01", status: "scheduled" })
  ]
});

test("ひな形：templates/ の本文と既定の本文が同じ", () => {
  const file = readFileSync(new URL("../../../../../infra/v3/templates/rights_matrix_report.html", import.meta.url), "utf8").trimEnd();
  assert.equal(RIGHTS_MATRIX_REPORT_TEMPLATE_HTML, file);
  assert.ok(file.includes('data-layout="rmr-v1'), "版の目印");
});

test("作品 1 点：行・列・マスの印、要確認（ぶつかり・範囲外）、許諾の一覧", () => {
  const v = workReportValues(matrix(), { company, documentDate: "2026-11-08", remarks: "来期の更新候補" }) as any;
  assert.equal(v.isWork, true);
  assert.equal(v.SUBTITLE, "作品：星降る夜のミュゼ");
  assert.equal(v.COMPANY_NAME, "株式会社テスト");
  assert.deepEqual(v.languages.map((l: any) => l.label), ["日本語", "英語", "ポルトガル語", "その他の言語"]);
  assert.deepEqual(v.rows.map((r: any) => r.label), ["日本", "アメリカ合衆国", "その他の地域"]);
  assert.equal(v.acquired.known, true);
  assert.equal(v.acquired.regions, "日本・アメリカ合衆国");
  assert.equal(v.summary.grants, 4);
  assert.equal(v.summary.parties, 4);
  assert.equal(v.summary.conflict, 1);
  assert.equal(v.summary.outside, 1, "ポルトガル語は取っていない言語");
  assert.equal(v.work.derivedNote, "派生作品 1 点（言語版など）の許諾を含む");

  const jpJa = v.rows[0].cells[0];
  assert.equal(jpJa.state, "conflict");
  assert.equal(jpJa.mark, "✕ ぶつかり");
  assert.deepEqual(jpJa.names, ["A社", "B社"]);
  assert.equal(jpJa.more, 0);
  assert.equal(v.rows[1].cells[1].state, "non_exclusive", "予定の非独占");
  assert.equal(v.rows[1].cells[2].state, "outside");
  assert.equal(v.rows[1].cells[0].state, "open", "アメリカ × 日本語は取った範囲の内で未許諾");

  assert.equal(v.issues.length, 2);
  assert.equal(v.issues[0].kind, "conflict");
  assert.equal(v.issues[0].place, "日本 × 日本語");
  assert.match(v.issues[0].text, /A社（独占・2026-01-01 〜 2028-12-31）と B社（非独占/);
  assert.equal(v.issues[1].kind, "outside");
  assert.equal(v.issues[1].place, "アメリカ合衆国 × ポルトガル語");

  assert.equal(v.grants.length, 4);
  assert.deepEqual(v.grants.map((g: any) => g.index), [1, 2, 3, 4]);
  assert.equal(v.grants[2].workTitle, "星降る夜のミュゼ（英語版）", "派生作品の許諾は作品名を添える");
  assert.equal(v.grants[0].workTitle, null);
  assert.equal(v.grants[3].flag, "予定");
  assert.equal(v.grants[0].exclText, "独占");
  assert.equal(v.grants[2].regionsText, "アメリカ合衆国");
  assert.equal(v.grants[0].languagesText, "日本語");
  assert.equal(v.remarks, "来期の更新候補");
});

test("作品 1 点：取引先で絞ると、その取引先の無いマスが薄くなり、許諾の一覧がその取引先だけになる", () => {
  const v = workReportValues(matrix(), { company, documentDate: "2026-11-08", partyId: 3 }) as any;
  assert.equal(v.partyFilter, "C社");
  assert.equal(v.rows[0].cells[0].dim, true, "日本 × 日本語には C社がいない");
  assert.equal(v.rows[1].cells[2].dim, false, "アメリカ × ポルトガル語には C社がいる");
  assert.deepEqual(v.grants.map((g: any) => g.partyName), ["C社"]);
  // 絞っても概要の数は表全体のまま（取引先の数は 4 社）。
  assert.equal(v.summary.grants, 4);
});

test("作品 1 点：マスの取引先が多いときは 3 社まで出して「ほか n」", () => {
  const m = buildRightsMatrix({
    work: { id: 1, title: "作品" }, today: "2026-11-08", includeEnded: false, envelope: null,
    grants: [1, 2, 3, 4, 5].map((id) => grant({ id, partyName: `相手${id}`, regions: [JP], languages: [JA] }))
  });
  const v = workReportValues(m, { company, documentDate: "2026-11-08" }) as any;
  assert.deepEqual(v.rows[0].cells[0].names, ["相手1", "相手2", "相手3"]);
  assert.equal(v.rows[0].cells[0].more, 2);
  assert.equal(v.acquired.known, false);
  assert.equal(v.issues.length, 0, "作者の条件が無ければ範囲外とは言わない");
});

test("作品 1 点：許諾も作者の条件も無ければ表を出さない", () => {
  const m = buildRightsMatrix({ work: { id: 1, title: "空" }, today: "2026-11-08", includeEnded: false, envelope: null, grants: [] });
  const v = workReportValues(m, { company, documentDate: "2026-11-08" }) as any;
  assert.deepEqual(v.rows, []);
  const html = renderDocumentHtml(RIGHTS_MATRIX_REPORT_TEMPLATE_HTML, v);
  assert.match(html, /許諾（OUT の利用許諾の条件）も作者の条件もありません/);
});

test("作品 1 点：ひな形で描けて、題名・取引先・印・要確認・備考が本文に出る", () => {
  const v = workReportValues(matrix(), { company, documentDate: "2026-11-08", remarks: "来期の更新候補" });
  const html = renderDocumentHtml(RIGHTS_MATRIX_REPORT_TEMPLATE_HTML, v);
  assert.match(html, /<title>許諾地域・許諾言語レポート<\/title>/);
  assert.match(html, /作品：星降る夜のミュゼ/);
  assert.match(html, /基準日: 2026年11月8日/);
  assert.match(html, /作成日: 2026年11月8日/);
  assert.match(html, /株式会社テスト/);
  assert.match(html, /<td class="cell conflict">/);
  assert.match(html, /<td class="cell open">/);
  assert.match(html, /<td class="cell outside">/);
  assert.match(html, /✕ ぶつかり/);
  assert.match(html, /■ 要確認/);
  assert.match(html, /<b>日本 × 日本語<\/b>/);
  assert.match(html, /■ 許諾の一覧/);
  assert.match(html, /星降る夜のミュゼ（英語版）/);
  assert.match(html, /<b>備考<\/b>/);
  assert.match(html, /来期の更新候補/);
  assert.match(html, /基準日より前に終わった許諾は載せていません/);
  assert.doesNotMatch(html, /\{\{/, "差し込みの残りが無い");
  assert.doesNotMatch(html, /作品 ＼ 言語/, "作品をまたぐ一覧の段は出ない");
});

const overviewWorks = (): OverviewWork[] => [
  {
    id: 1, title: "星降る夜のミュゼ", workCode: "WRK-1", businessLine: "出版", inUsageTypes: ["pub_paper"], derived: 1,
    grants: [
      grant({ id: 1, partyName: "A社", regions: [JP], languages: [JA], exclusivity: "exclusive" }),
      grant({ id: 2, partyName: "B社", regions: [JP], languages: [JA] })
    ],
    envelope: envelope([JP, US], [JA, EN])
  },
  {
    id: 2, title: "ボードゲーム X", workCode: null, businessLine: "ゲーム", inUsageTypes: ["in_house"], derived: 0,
    grants: [grant({ id: 3, partyName: "C社", regions: [US], languages: [EN] })],
    envelope: envelope([US], [EN])
  }
];

test("作品をまたぐ一覧：絞り込みの表示、行の札、マスの印と空きの地域の数", () => {
  const o = buildOverview({ today: "2026-11-08", includeEnded: false, works: overviewWorks(), show: "granted" });
  const v = overviewReportValues(o, { company, documentDate: "2026-11-08", show: "granted", category: null }) as any;
  assert.equal(v.isWork, false);
  assert.equal(v.SUBTITLE, "作品をまたぐ一覧（全地域）");
  assert.equal(v.regionLabel, null);
  assert.deepEqual(v.filters.map((f: any) => [f.label, f.value]),
    [["地域", "すべての地域（畳む）"], ["出す作品", "許諾のある作品"], ["終わった許諾", "含まない"]]);
  assert.equal(v.summary.works, 2);
  assert.equal(v.summary.conflict, 1);
  assert.equal(v.summary.truncated, false);
  // ぶつかりのある作品が先。
  assert.equal(v.rows[0].title, "星降る夜のミュゼ");
  assert.equal(v.rows[0].categoryLabel, "出版");
  assert.equal(v.rows[0].derived, 1);
  assert.equal(v.rows[0].conflict, true);
  assert.equal(v.rows[0].workCode, "WRK-1");
  assert.equal(v.rows[1].categoryLabel, "ボードゲーム等");
  // 日本語の列：星降る夜のミュゼは日本でぶつかり、アメリカは空き → 畳むとぶつかりに「空き 1 地域」。
  const ja = v.rows[0].cells[v.languages.findIndex((l: any) => l.label === "日本語")];
  assert.equal(ja.state, "conflict");
  assert.deepEqual(ja.names, ["A社", "B社"]);
  assert.equal(ja.openRegions, 1);
  const en = v.rows[0].cells[v.languages.findIndex((l: any) => l.label === "英語")];
  assert.equal(en.state, "open");
  assert.equal(en.openRegions, 0, "空きのマスそのものには数を添えない");
});

test("作品をまたぐ一覧：地域を選ぶと副題と見出しに地域が出て、取引先で絞ると薄く出る", () => {
  const o = buildOverview({ today: "2026-11-08", includeEnded: true, works: overviewWorks(), region: "US", partyId: 3, show: "all" });
  const v = overviewReportValues(o, { company, documentDate: "2026-11-08", show: "all", partyId: 3, q: "ミュゼ", category: "game" }) as any;
  assert.equal(v.SUBTITLE, "作品をまたぐ一覧（地域：アメリカ合衆国）");
  assert.equal(v.regionLabel, "アメリカ合衆国");
  assert.deepEqual(v.filters.map((f: any) => f.label), ["地域", "出す作品", "題名・コード", "カテゴリ", "取引先", "終わった許諾"]);
  assert.equal(v.filters.find((f: any) => f.label === "取引先").value, "C社");
  assert.equal(v.filters.find((f: any) => f.label === "終わった許諾").value, "含む");
  const row = v.rows.find((r: any) => r.title === "ボードゲーム X");
  const en = row.cells[v.languages.findIndex((l: any) => l.label === "英語")];
  assert.equal(en.dim, false);
  assert.equal(en.openRegions, 0, "地域を選んだときは空きの地域の数を出さない");
  const html = renderDocumentHtml(RIGHTS_MATRIX_REPORT_TEMPLATE_HTML, v);
  assert.match(html, /■ 作品 × 許諾言語（地域：アメリカ合衆国）/);
  assert.match(html, /作品 ＼ 言語/);
  assert.match(html, /<span class="tag">ボードゲーム等<\/span>/);
  assert.match(html, /地域を選ばないときは/);
  assert.doesNotMatch(html, /\{\{/);
  assert.doesNotMatch(html, /■ 許諾の一覧/, "作品 1 点の段は出ない");
});

test("ファイル名：使えない文字を落とす", () => {
  assert.equal(fileSafe('星降る/夜:の*ミュゼ?"<>|'), "星降る_夜_の_ミュゼ_____");
  assert.equal(fileSafe("   "), "report");
});
