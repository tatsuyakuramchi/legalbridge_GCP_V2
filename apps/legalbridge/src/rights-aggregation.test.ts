import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGrantCoverage, buildLicenseMatrix, buildRightsTree, buildTerritorySummary,
  classifyRight, findWideGrantOverlaps, isRunningRight, runningCalcLabel, splitTerms,
  type RightsLine
} from "./rights-aggregation.js";

// 判定ルールは V1（workModel.ts /api/v3/works/:id/rights-tree）から引き継いだもの。
// UI は再設計するが、ここのルールが変わると二重許諾の検知や買い切り集計が変わって
// しまうため、V1 の挙動をテストで固定する。

const line = (over: Partial<RightsLine>): RightsLine => ({
  id: 1, direction: "payable", name: "出版権", party: "株式会社エー",
  paymentScheme: null, calcMethod: null, ratePct: null, mgAmount: null,
  amountExTax: null, currency: null, formulaText: null,
  territory: null, language: null, documentNumber: null, ...over
});

// ── ランニング判定（V1 isRunning）─────────────────────────────────
test("継続型スキーム・計算方式はランニング", () => {
  for (const scheme of ["royalty", "subscription", "per_unit", "installment"]) {
    assert.equal(isRunningRight(line({ paymentScheme: scheme })), true, scheme);
  }
  for (const method of ["ROYALTY", "SUBSCRIPTION", "PER_UNIT", "INSTALLMENT"]) {
    assert.equal(isRunningRight(line({ calcMethod: method })), true, method);
  }
});

test("料率か MG があればスキーム不明でもランニング", () => {
  assert.equal(isRunningRight(line({ ratePct: 5 })), true);
  assert.equal(isRunningRight(line({ ratePct: 0 })), true);   // 0% も「料率あり」＝V1 と同じ
  assert.equal(isRunningRight(line({ mgAmount: 100000 })), true);
  assert.equal(isRunningRight(line({ mgAmount: 0 })), false); // MG 0 は無視＝V1 と同じ
  assert.equal(isRunningRight(line({})), false);
});

// ── 分類（own/run/free 相当）──────────────────────────────────────
test("固定額あり＝買い切り、ランニング条件あり＝ランニング、どちらも無し＝無償", () => {
  assert.equal(classifyRight(line({ amountExTax: 500000 })).kind, "buyout");
  assert.equal(classifyRight(line({ ratePct: 5 })).kind, "running");
  assert.equal(classifyRight(line({})).kind, "free");
  assert.equal(classifyRight(line({ amountExTax: 0 })).kind, "free");
});

test("計算条件の表示（V1 calcLabel と同じ優先順）", () => {
  assert.equal(runningCalcLabel(line({ ratePct: 5 })), "印税 5%");
  assert.equal(runningCalcLabel(line({ ratePct: 5, mgAmount: 100000 })), "MG ¥100,000 ＋ 5%");
  assert.equal(runningCalcLabel(line({ mgAmount: 100000 })), "MG ¥100,000");
  assert.equal(runningCalcLabel(line({ ratePct: 0, formulaText: "純売上の3%" })), "純売上の3%");
  assert.equal(runningCalcLabel(line({ paymentScheme: "subscription" })), "定期課金");
  assert.equal(runningCalcLabel(line({ paymentScheme: "per_unit" })), "計算条件あり");
});

test("分類結果は金額ラベルと無償表示を持つ", () => {
  assert.equal(classifyRight(line({ amountExTax: 500000 })).amountLabel, "¥500,000");
  assert.equal(classifyRight(line({})).calcLabel, "無償");
  assert.equal(classifyRight(line({ party: null })).party, "(取引先未設定)");
});

// ── 地域・言語の分解と地域サマリー ──────────────────────────────────
test("連結された地域・言語を V1 と同じ区切りで分解する", () => {
  assert.deepEqual(splitTerms("日本・韓国"), ["日本", "韓国"]);
  assert.deepEqual(splitTerms("日本, 台湾／香港、中国"), ["日本", "台湾", "香港", "中国"]);
  assert.deepEqual(splitTerms(null), []);
});

test("地域サマリーは地域→言語→権利をロールアップする", () => {
  const summary = buildTerritorySummary([
    line({ direction: "receivable", name: "出版権", territory: "日本・韓国", language: "日本語" }),
    line({ direction: "receivable", name: "映像化権", territory: "日本", language: "日本語・英語" })
  ]);
  const japan = summary.find((entry) => entry.territory === "日本")!;
  assert.deepEqual(japan.languages, ["日本語", "英語"]);
  assert.deepEqual(japan.rights, ["出版権", "映像化権"]);
  assert.ok(summary.some((entry) => entry.territory === "韓国"));
});

test("地域未設定は（地域未設定）として集計する", () => {
  const summary = buildTerritorySummary([line({ direction: "receivable", territory: null })]);
  assert.equal(summary[0].territory, "（地域未設定）");
});

// ── 重複警告（広域×個別・二重許諾の検知）────────────────────────────
test("全世界許諾と個別地域で同一言語が重なれば警告する", () => {
  const overlaps = findWideGrantOverlaps(buildTerritorySummary([
    line({ direction: "receivable", name: "出版権", territory: "全世界", language: "英語" }),
    line({ direction: "receivable", name: "出版権", territory: "韓国", language: "英語" }),
    line({ direction: "receivable", name: "出版権", territory: "台湾", language: "中国語" })
  ]));
  assert.deepEqual(overlaps, ["韓国（英語）"]);
});

test("広域判定は worldwide/global/all も拾う（V1 と同じ語彙）", () => {
  for (const world of ["全世界", "世界", "Worldwide", "GLOBAL", "all countries"]) {
    const overlaps = findWideGrantOverlaps(buildTerritorySummary([
      line({ direction: "receivable", territory: world, language: "英語" }),
      line({ direction: "receivable", territory: "韓国", language: "英語" })
    ]));
    assert.equal(overlaps.length, 1, world);
  }
});

test("広域許諾が無ければ個別地域同士は警告しない", () => {
  const overlaps = findWideGrantOverlaps(buildTerritorySummary([
    line({ direction: "receivable", territory: "日本", language: "日本語" }),
    line({ direction: "receivable", territory: "韓国", language: "日本語" })
  ]));
  assert.deepEqual(overlaps, []);
});

// ── ツリー全体 ─────────────────────────────────────────────────────
test("取得（payable）と許諾（receivable）に分け、買い切り合計を出す", () => {
  const tree = buildRightsTree([
    line({ id: 1, direction: "payable", amountExTax: 500000 }),
    line({ id: 2, direction: "payable", amountExTax: 300000 }),
    line({ id: 3, direction: "payable", ratePct: 5 }),
    line({ id: 4, direction: "receivable", territory: "日本", language: "日本語" })
  ]);
  assert.equal(tree.acquired.length, 3);
  assert.equal(tree.granted.length, 1);
  assert.equal(tree.totals.buyoutCount, 2);
  assert.equal(tree.totals.buyoutAmount, 800000);
});

// ── ライセンスマトリクス（横断）────────────────────────────────────
const MATRIX_LINES: RightsLine[] = [
  line({ id: 1, workId: 10, workTitle: "作品A", direction: "receivable",
    name: "出版権", territory: "全世界", language: "英語", party: "海外社",
    documentNumber: "ARC-LIC-001" }),
  line({ id: 2, workId: 10, workTitle: "作品A", direction: "receivable",
    name: "出版権", territory: "韓国", language: "英語", party: "韓国社" }),
  line({ id: 3, workId: 20, workTitle: "作品B", direction: "receivable",
    name: "映像化権", territory: "日本", language: "日本語", party: "国内社" }),
  line({ id: 4, workId: 20, workTitle: "作品B", direction: "payable",
    name: "原作使用", territory: "日本" })   // 取得側はマトリクスに出さない
];

test("マトリクスは作品×地域に言語・権利・相手先を集約する", () => {
  const matrix = buildLicenseMatrix(MATRIX_LINES);
  const workA = matrix.rows.find((row) => row.workId === 10)!;
  assert.deepEqual(workA.cells["韓国"].parties, ["韓国社"]);
  assert.deepEqual(workA.cells["全世界"].documentNumbers, ["ARC-LIC-001"]);
  const workB = matrix.rows.find((row) => row.workId === 20)!;
  assert.deepEqual(Object.keys(workB.cells), ["日本"]);
});

test("列は広域を先頭に並べ、行ごとに重複警告を持つ", () => {
  const matrix = buildLicenseMatrix(MATRIX_LINES);
  assert.equal(matrix.territories[0], "全世界");
  const workA = matrix.rows.find((row) => row.workId === 10)!;
  assert.deepEqual(workA.overlaps, ["韓国（英語）"]);
  const workB = matrix.rows.find((row) => row.workId === 20)!;
  assert.deepEqual(workB.overlaps, []);
});

test("取得側（payable）の行はマトリクスに含めない", () => {
  const matrix = buildLicenseMatrix(MATRIX_LINES);
  const workB = matrix.rows.find((row) => row.workId === 20)!;
  assert.equal("原作使用" in workB.cells, false);
  assert.ok(!Object.values(workB.cells).some((cell) => cell.rights.includes("原作使用")));
});

// ── アウト側の許諾地域カバレッジ（被り検知の強化）──────────────────────
// 許諾地域の被りは二重許諾＝致命的、という運用要件（2026-08-18）。
// V1 の「広域×個別の同一言語」に加えて、同一地域×同一言語×同一権利の
// 複数許諾を error として検知する。

test("カバレッジは地域×言語の格子に許諾を集約し、全世界を先頭にする", () => {
  const coverage = buildGrantCoverage([
    line({ id: 1, direction: "receivable", name: "出版権", territory: "韓国", language: "韓国語", party: "韓国社" }),
    line({ id: 2, direction: "receivable", name: "出版権", territory: "全世界", language: "英語", party: "海外社",
      documentNumber: "ARC-LIC-001" })
  ]);
  assert.equal(coverage.rows[0].territory, "全世界");
  assert.equal(coverage.rows[0].isWorldwide, true);
  assert.deepEqual(coverage.rows[1].languages["韓国語"].map((c) => c.party), ["韓国社"]);
  assert.deepEqual(coverage.languages, ["韓国語", "英語"]);
  assert.deepEqual(coverage.conflicts, []);
});

test("同一地域×同一言語×同一権利を複数の相手に出していれば error", () => {
  const coverage = buildGrantCoverage([
    line({ id: 1, direction: "receivable", name: "出版権", territory: "韓国", language: "韓国語",
      party: "A社", documentNumber: "ARC-LIC-001" }),
    line({ id: 2, direction: "receivable", name: "出版権", territory: "韓国", language: "韓国語",
      party: "B社", documentNumber: "ARC-LIC-002" })
  ]);
  assert.equal(coverage.conflicts.length, 1);
  const conflict = coverage.conflicts[0];
  assert.equal(conflict.severity, "error");
  assert.deepEqual(conflict.parties.sort(), ["A社", "B社"]);
  assert.deepEqual(conflict.documentNumbers.sort(), ["ARC-LIC-001", "ARC-LIC-002"]);
  assert.match(conflict.message, /複数の明細で許諾/);
});

test("全世界許諾と個別地域で同一権利×同一言語なら error（相手先を並べる）", () => {
  const coverage = buildGrantCoverage([
    line({ id: 1, direction: "receivable", name: "出版権", territory: "全世界", language: "英語", party: "海外社" }),
    line({ id: 2, direction: "receivable", name: "出版権", territory: "韓国", language: "英語", party: "韓国社" })
  ]);
  const errors = coverage.conflicts.filter((c) => c.severity === "error");
  assert.equal(errors.length, 1);
  assert.deepEqual(errors[0].parties.sort(), ["海外社", "韓国社"]);
  assert.match(errors[0].message, /全世界許諾と韓国許諾が重なっています/);
});

test("広域と言語圏だけ重なり権利が別なら warning（V1 相当の注意喚起）", () => {
  const coverage = buildGrantCoverage([
    line({ id: 1, direction: "receivable", name: "出版権", territory: "全世界", language: "英語", party: "海外社" }),
    line({ id: 2, direction: "receivable", name: "映像化権", territory: "韓国", language: "英語", party: "韓国社" })
  ]);
  assert.equal(coverage.conflicts.length, 1);
  assert.equal(coverage.conflicts[0].severity, "warning");
  assert.match(coverage.conflicts[0].message, /言語圏が重なっています（権利は別）/);
});

test("言語が違えば被りではない", () => {
  const coverage = buildGrantCoverage([
    line({ id: 1, direction: "receivable", name: "出版権", territory: "全世界", language: "英語" }),
    line({ id: 2, direction: "receivable", name: "出版権", territory: "韓国", language: "韓国語" })
  ]);
  assert.deepEqual(coverage.conflicts, []);
});

test("連結地域は分解してから突き合わせる（日本・韓国 と 韓国 は被る）", () => {
  const coverage = buildGrantCoverage([
    line({ id: 1, direction: "receivable", name: "出版権", territory: "日本・韓国", language: "日本語", party: "A社" }),
    line({ id: 2, direction: "receivable", name: "出版権", territory: "韓国", language: "日本語", party: "B社" })
  ]);
  const errors = coverage.conflicts.filter((c) => c.severity === "error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].territory, "韓国");
});

test("error が warning より先に並ぶ", () => {
  const coverage = buildGrantCoverage([
    line({ id: 1, direction: "receivable", name: "出版権", territory: "全世界", language: "英語", party: "海外社" }),
    line({ id: 2, direction: "receivable", name: "映像化権", territory: "韓国", language: "英語", party: "韓国社" }),
    line({ id: 3, direction: "receivable", name: "出版権", territory: "台湾", language: "英語", party: "台湾社" })
  ]);
  assert.ok(coverage.conflicts.length >= 2);
  assert.equal(coverage.conflicts[0].severity, "error");
});
