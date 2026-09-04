import assert from "node:assert/strict";
import test from "node:test";
import { ledgerToFormSeed } from "./condition-ledger-seed.js";
import { emptyLedgerPayload, type ConditionLedgerPayload } from "../condition-ledger.js";
import { codedNamesFromText, searchCodedNames, TERRITORY_GROUPS, LANGUAGE_GROUPS } from "./territory-master.js";

function payload(): ConditionLedgerPayload {
  return {
    ...emptyLedgerPayload(), workCode: "WRK-10013", workTitle: "エピローグ", vendorId: 7, vendorName: "スタジオ雨宿り",
    kinds: ["service", "license_in", "license_out"],
    payments: [
      { scheme: "lump_sum", materialCode: "WRK-10013-002", name: "イラスト制作費", amountExTax: 300000, paymentTerms: "納品月の翌月末" },
      { scheme: "installment", materialCode: "", name: "翻訳", amountExTax: 200000, paymentTerms: "50/50" }
    ],
    expenses: [{ name: "交通費", amountExTax: 20000, taxCategory: "taxable", settlement: "実費精算" }],
    fees: [{ name: "印紙", amountExTax: 200, taxCategory: "exempt", notes: "立替" }],
    licenseIn: [{ materialCode: "WRK-10013-001", name: "原作ロイヤリティ", ratePct: 5, mgAmount: 100000, agAmount: null, groupNo: 1,
      regions: [{ code: "JP", name: "日本" }, { code: "TW", name: "台湾" }], languages: [{ code: "ja", name: "日本語" }], basePriceLabel: "", paymentTerms: "" }],
    licenseOut: [{ materialCode: "", name: "英語版", ratePct: 8, mgAmount: 500000, agAmount: null, groupNo: null,
      regions: [{ code: "R-NA", name: "北米" }, { code: "GB", name: "イギリス" }], languages: [{ code: "en", name: "英語" }], basePriceLabel: "", paymentTerms: "" }]
  };
}
const ledger = { id: 501, documentNumber: "CT-2026-00042", lineCodes: { 1001: "CL-2026-00140", 2001: "CL-2026-00160", 5001: "CL-2026-00120" } };

test("発注書: 支払→明細、経費→税込換算＋税区分、手数料→その他手数料、許諾インは金銭条件。台帳キーを持つ", () => {
  const seed = ledgerToFormSeed(payload(), "purchase_order", ledger);
  assert.equal(seed.condition_ledger_id, "501");
  assert.equal(seed.condition_ledger_number, "CT-2026-00042");
  assert.equal(seed.flow_direction, "in");
  assert.equal(seed.work_code, "WRK-10013");
  const items = seed.items as Array<Record<string, unknown>>;
  assert.equal(items.length, 2);
  assert.equal(items[0].item_name, "イラスト制作費");
  assert.equal(items[0].amount_ex_tax, "300000");
  assert.equal(items[0].calc_method, "FIXED");
  assert.equal(items[0].condition_line_code, "CL-2026-00140");
  assert.equal(items[1].fixed_kind, "INSTALLMENT");
  const expenses = seed.expenses as Array<Record<string, unknown>>;
  assert.equal(expenses[0].amount_inc_tax, "22000");
  assert.equal(expenses[0].tax_category, "taxable");
  assert.equal(expenses[0].condition_line_code, "CL-2026-00160");
  const fees = seed.other_fees as Array<Record<string, unknown>>;
  assert.equal(fees[0].amount, "200");
  assert.equal(fees[0].tax_category, "exempt");
  const fc = seed.financial_conditions as Array<Record<string, unknown>>;
  assert.equal(fc.length, 1);
  assert.equal(fc[0].rate_pct, "5");
  assert.equal(fc[0].guarantee_type, "MG");
  assert.equal(fc[0].region_territory, "日本・台湾");
  assert.equal(fc[0].condition_line_code, "CL-2026-00120");
});

test("個別条件書V3: 料率行が構成要素（v3_lcs）になり、MG は取引形態1に集約、地域・言語を差し込む", () => {
  const seed = ledgerToFormSeed(payload(), "individual_license_terms_v3", ledger);
  assert.equal(seed.work_id, "WRK-10013");
  assert.equal(seed.対象製品予定名, "エピローグ");
  assert.equal(seed.Licensor_氏名会社名, "スタジオ雨宿り");
  const deals = seed.v3_conds as Array<Record<string, unknown>>;
  assert.equal(deals.length, 3);
  assert.equal(deals[0].mg, "100000");
  assert.equal(deals[0].reg, "日本・台湾");
  const lcs = seed.v3_lcs as Array<Record<string, unknown>>;
  assert.equal(lcs[0].material_code, "WRK-10013-001");
  assert.deepEqual(lcs[0].rates, { "1": "5" });
  assert.equal(lcs[0].condition_line_code, "CL-2026-00120");
  assert.equal("items" in seed, false);   // 業務委託の行は条件書に持ち込まない
});

test("ライセンスアウト契約: 向きは out、Territory/Language は英文区切りで差し込む", () => {
  const seed = ledgerToFormSeed(payload(), "license_out_en", ledger);
  assert.equal(seed.flow_direction, "out");
  assert.equal(seed.TERRITORY, "北米 / イギリス");
  assert.equal(seed.LANGUAGE, "英語");
  assert.equal(seed.ROYALTY_RATE, "8");
  assert.equal(seed.MINIMUM_GUARANTEE, "500000");
  const fc = seed.financial_conditions as Array<Record<string, unknown>>;
  assert.equal(fc[0].condition_name, "英語版");
});

test("地域・言語マスタ: 検索は名前・コードの部分一致で選択済みを除き、旧文字列はコードを補って復元する", () => {
  const hits = searchCodedNames(TERRITORY_GROUPS, "台", []);
  assert.ok(hits.some((g) => g.items.some((i) => i.code === "TW")));
  const excluded = searchCodedNames(TERRITORY_GROUPS, "日本", [{ code: "JP", name: "日本" }]);
  assert.equal(excluded.some((g) => g.items.some((i) => i.code === "JP")), false);
  assert.ok(searchCodedNames(LANGUAGE_GROUPS, "en", []).some((g) => g.items.some((i) => i.code === "en")));
  assert.deepEqual(codedNamesFromText("日本・台湾・火星", TERRITORY_GROUPS),
    [{ code: "JP", name: "日本" }, { code: "TW", name: "台湾" }, { code: null, name: "火星" }]);
  const all = TERRITORY_GROUPS.flatMap((g) => g.items);
  assert.equal(new Set(all.map((i) => i.code)).size, all.length);   // コード重複なし
  assert.ok(all.length > 190);
});
