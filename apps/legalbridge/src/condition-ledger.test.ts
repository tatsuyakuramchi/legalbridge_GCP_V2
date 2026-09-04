import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyLedgerPayload, ledgerDocumentChoices, ledgerFlow, ledgerTaxSummary, ledgerToConditionInputs,
  type ConditionLedgerPayload
} from "./condition-ledger.js";

function payload(overrides: Partial<ConditionLedgerPayload>): ConditionLedgerPayload {
  return { ...emptyLedgerPayload(), vendorId: 7, vendorName: "スタジオ雨宿り", title: "テスト契約", ...overrides };
}

test("業務委託: 支払・経費・手数料が種類別の帯（line_no）と line_kind／税区分で台帳行になる", () => {
  const rows = ledgerToConditionInputs(payload({
    kinds: ["service"],
    payments: [
      { scheme: "lump_sum", materialCode: "WRK-1-002", name: "イラスト制作費", amountExTax: 300000, paymentTerms: "納品月の翌月末" },
      { scheme: "installment", materialCode: "", name: "翻訳", amountExTax: 200000, paymentTerms: "50/50" }
    ],
    expenses: [{ name: "取材交通費", amountExTax: 20000, taxCategory: "taxable", settlement: "実費精算（領収書）" }],
    fees: [{ name: "収入印紙代", amountExTax: 200, taxCategory: "exempt", notes: "立替" }],
    // 種類に無い許諾行は無視される（チェックを外した種類の残骸を台帳に入れない）
    licenseIn: [{ materialCode: "", name: "無視", ratePct: 5, mgAmount: null, agAmount: null, groupNo: null, regions: [], languages: [], basePriceLabel: "", paymentTerms: "" }]
  }));
  assert.deepEqual(rows.map((r) => r.line_no), [1001, 1002, 2001, 3001]);
  assert.equal(rows[0].payment_scheme, "lump_sum");
  assert.equal(rows[0].transaction_kind, "service");
  assert.equal(rows[0].line_kind, "payment");
  assert.equal(rows[0].material_code, "WRK-1-002");
  assert.equal(rows[0].amount_ex_tax, 300000);
  assert.equal(rows[0].counterparty_vendor_id, 7);
  assert.equal(rows[1].payment_scheme, "installment");
  assert.equal(rows[2].line_kind, "expense");
  assert.equal(rows[2].tax_category, "taxable");
  assert.equal(rows[2].notes, "実費精算（領収書）");
  assert.equal(rows[3].line_kind, "fee");
  assert.equal(rows[3].tax_category, "exempt");
  assert.ok(rows.every((r) => r.direction === "payable"));
});

test("利用許諾: イン＝payable・アウト＝receivable、地域・言語は子テーブル配列＋結合文字列の両方を持つ", () => {
  const lic = {
    materialCode: "WRK-1-001", name: "原作ロイヤリティ", ratePct: 5, mgAmount: 100000, agAmount: 0, groupNo: 1,
    regions: [{ code: "JP", name: "日本" }, { code: "TW", name: "台湾" }],
    languages: [{ code: "ja", name: "日本語" }, { code: null, name: "" }],
    basePriceLabel: "上代×数量", paymentTerms: "年1回"
  };
  const rows = ledgerToConditionInputs(payload({ kinds: ["license_in", "license_out"], licenseIn: [lic], licenseOut: [{ ...lic, groupNo: null }] }));
  assert.equal(rows.length, 2);
  const [lin, lout] = rows;
  assert.equal(lin.line_no, 5001);
  assert.equal(lin.direction, "payable");
  assert.equal(lin.payment_scheme, "royalty");
  assert.equal(lin.transaction_kind, "license");
  assert.equal(lin.is_addon, true);
  assert.equal(lin.group_no, 1);
  assert.equal(lin.region_territory, "日本・台湾");
  assert.equal(lin.region_language, "日本語");
  assert.deepEqual(lin.regions, [{ code: "JP", name: "日本" }, { code: "TW", name: "台湾" }]);
  assert.deepEqual(lin.languages, [{ code: "ja", name: "日本語" }]);   // 空名は落とす
  assert.equal(lout.line_no, 6001);
  assert.equal(lout.direction, "receivable");
  assert.equal(lout.is_addon, false);
});

test("税区分別集計: 支払行は課税10%、経費・手数料は各行の税区分で集計し消費税・税込合計を出す", () => {
  const summary = ledgerTaxSummary(payload({
    kinds: ["service"],
    payments: [{ scheme: "lump_sum", materialCode: "", name: "A", amountExTax: 300000, paymentTerms: "" }],
    expenses: [
      { name: "交通費", amountExTax: 20000, taxCategory: "taxable", settlement: "" },
      { name: "書籍", amountExTax: 1000, taxCategory: "reduced", settlement: "" }
    ],
    fees: [{ name: "印紙", amountExTax: 200, taxCategory: "exempt", notes: "" }]
  }));
  assert.deepEqual(summary, { taxable: 320000, reduced: 1000, exempt: 200, tax: 32080, total: 353280 });
  // 業務委託を選んでいなければ集計は出ない
  assert.equal(ledgerTaxSummary(payload({ kinds: ["license_in"], payments: [{ scheme: "lump_sum", materialCode: "", name: "A", amountExTax: 1, paymentTerms: "" }] })).total, 0);
});

test("作れる文書は種類と行の有無で絞られ、展開区分で個別条件書の書式が変わる", () => {
  const base = payload({ kinds: ["service"], payments: [{ scheme: "lump_sum", materialCode: "", name: "A", amountExTax: 1, paymentTerms: "" }] });
  const game = ledgerDocumentChoices(base, "game");
  assert.equal(game.find((c) => c.templateKey === "purchase_order")?.blockedReason, null);
  assert.match(game.find((c) => c.templateKey === "individual_license_terms_v3")?.blockedReason ?? "", /利用許諾イン/);
  assert.equal(game.some((c) => c.templateKey === "pub_license_terms"), false);
  const pub = ledgerDocumentChoices({ ...base, kinds: ["license_in"], licenseIn: [] }, "publishing");
  assert.equal(pub.some((c) => c.templateKey === "individual_license_terms_v3"), false);
  assert.match(pub.find((c) => c.templateKey === "pub_license_terms")?.blockedReason ?? "", /料率行/);
  assert.match(pub.find((c) => c.templateKey === "purchase_order")?.blockedReason ?? "", /業務委託/);
  const out = ledgerDocumentChoices({ ...base, kinds: ["license_out"], licenseOut: [{ materialCode: "", name: "英語版", ratePct: 8, mgAmount: null, agAmount: null, groupNo: null, regions: [], languages: [], basePriceLabel: "", paymentTerms: "" }] }, null);
  assert.equal(out.find((c) => c.templateKey === "license_out_en")?.blockedReason, null);
});

test("台帳の向き: アウトだけなら out、混在は both", () => {
  assert.equal(ledgerFlow({ kinds: ["service"] }), "in");
  assert.equal(ledgerFlow({ kinds: ["license_out"] }), "out");
  assert.equal(ledgerFlow({ kinds: ["license_in", "license_out"] }), "both");
});
