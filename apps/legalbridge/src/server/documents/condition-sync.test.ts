import assert from "node:assert/strict";
import test from "node:test";
import {
  mapV3MatrixToConditions, mapFinancialConditions, buildDocumentConditionInputs,
  hasConditionSyncData, derivePaymentScheme, splitRegionLanguage
} from "./condition-sync.js";

// V1 documentSave.ts の v3 サンプル（individual-license-v3.ts の v3SampleFormData と同型）。
const V3_CONDS = [
  {
    id: "c1", name: "商品化（フィギュア）", addon: true,
    basePrice: "上代", cur: "JPY", mg: 500000, ag: 200000,
    reg: "日本・韓国", lang: "日本語",
    regions: [{ code: "JP", name: "日本" }, { code: "KR", name: "韓国" }],
    maxReg: "アジア", maxLang: "全言語"
  },
  { id: "c2", name: "出版（画集）", addon: false, fixedRate: 8, mg: 300000, cur: "JPY" }
];
const V3_LCS = [
  { material_code: "MAT-001", name: "キャラA", rates: { c1: 3, c2: "" } },
  { material_code: "MAT-002", name: "キャラB", rates: { c1: "2.5" } },
  { material_code: "MAT-003", name: "ロゴ", rates: {} }
];

test("v3加算型: 料率を持つLCごとに1行・group_noで束ね・MG/AGは先頭のみ", () => {
  const rows = mapV3MatrixToConditions(V3_CONDS, V3_LCS);
  const addon = rows.filter((r) => r.group_no === 1);
  assert.equal(addon.length, 2);                       // MAT-003 は料率なし＝行にならない
  assert.deepEqual(addon.map((r) => r.material_code), ["MAT-001", "MAT-002"]);
  assert.deepEqual(addon.map((r) => r.rate_pct), [3, "2.5"]);
  assert.equal(addon[0].mg_amount, 500000);
  assert.equal(addon[0].ag_amount, 200000);
  assert.equal(addon[1].mg_amount, null);              // 代表のみ
  assert.equal(addon[0].payment_scheme, "royalty");
  assert.ok(addon.every((r) => r.is_addon));
  // 選択式 regions は code つきで保持・line_no は 4000+ レンジ
  assert.deepEqual(addon[0].regions, [{ code: "JP", name: "日本" }, { code: "KR", name: "韓国" }]);
  assert.ok(addon.every((r) => r.line_no > 4000));
});

test("v3非加算型: 取引形態ごとに1本・実効料率・素材結線なし", () => {
  const rows = mapV3MatrixToConditions(V3_CONDS, V3_LCS);
  const fixed = rows.filter((r) => r.group_no === 2);
  assert.equal(fixed.length, 1);
  assert.equal(fixed[0].rate_pct, 8);
  assert.equal(fixed[0].mg_amount, 300000);
  assert.equal(fixed[0].material_code, null);
  assert.equal(fixed[0].is_addon, false);
  assert.equal(fixed[0].condition_name, "出版（画集）");
});

test("financial_conditions: condition_no 優先・料率あり=royalty導出・向きの伝播", () => {
  const rows = mapFinancialConditions([
    { condition_no: 5, condition_name: "利用許諾料", rate_pct: 10, mg_amount: 100000, currency: "JPY" },
    { condition_name: "一時金", unit_amount: 50000 }
  ], "receivable");
  assert.equal(rows[0].line_no, 5);
  assert.equal(rows[1].line_no, 2);       // 未指定は idx+1
  assert.ok(rows.every((r) => r.direction === "receivable"));
  assert.equal(derivePaymentScheme(rows[0]), "royalty");
  assert.equal(derivePaymentScheme(rows[1]), "lump_sum");
});

test("buildDocumentConditionInputs: 金銭条件とv3を合算・flow_direction=outで受取側", () => {
  const inputs = buildDocumentConditionInputs({
    flow_direction: "out",
    financial_conditions: [{ condition_name: "再許諾料", rate_pct: 5 }],
    v3_conds: [V3_CONDS[1]], v3_lcs: []
  });
  assert.equal(inputs.length, 2);
  assert.ok(inputs.every((r) => r.direction === "receivable"));
  // line_no は金銭条件(1)と v3(4001+) で衝突しない
  assert.deepEqual(inputs.map((r) => r.line_no), [1, 4001]);
});

test("hasConditionSyncData: 条件データが無い文書は対象外", () => {
  assert.equal(hasConditionSyncData({}), false);
  assert.equal(hasConditionSyncData({ financial_conditions: [] }), false);
  assert.equal(hasConditionSyncData({ financial_conditions: [{ rate_pct: 1 }] }), true);
  assert.equal(hasConditionSyncData({ v3_conds: [{ id: "c1" }] }), true);
});

test("splitRegionLanguage: 結合文字列の分解（V1互換の区切り）", () => {
  assert.deepEqual(splitRegionLanguage("日本・韓国、台湾"), [
    { code: null, name: "日本" }, { code: null, name: "韓国" }, { code: null, name: "台湾" }
  ]);
  assert.deepEqual(splitRegionLanguage(""), []);
  assert.deepEqual(splitRegionLanguage(null), []);
});
