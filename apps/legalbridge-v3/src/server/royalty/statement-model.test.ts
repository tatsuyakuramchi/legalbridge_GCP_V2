import test from "node:test";
import assert from "node:assert/strict";
import { STATEMENT_MODELS, companyShortName, modelSummary, modelSummaryLabel, statementModelPatch } from "./statement-model.js";
import { USAGE_TYPES } from "./usage-type.js";
import { royaltyStatementPatch, singleStatementPatch, usageBundleLines } from "../documents/royalty-patch.js";

test("表は利用形態を全部持つ", () => {
  assert.deepEqual(STATEMENT_MODELS.map((m) => m.usageType).sort(), USAGE_TYPES.map((t) => t.value).sort());
});

test("利用形態が分からなければ何も変えない", () => {
  assert.deepEqual(statementModelPatch([]), {});
  assert.deepEqual(statementModelPatch([null, "unknown"]), {});
});

test("取引モデルが1つなら日付の見出しも渡す。「■ 取引モデル」の表の欄は空にしない", () => {
  const p = statementModelPatch(["in_house", "in_house"]);
  assert.equal(p.transactionModel, "in_house");
  assert.equal(p.transactionModelLabel, "自社製造・自社販売");
  assert.equal(p.calcType, "manufacturing", "日付の見出しは製造完了日");
  assert.ok(!("payerCompany" in p) && !("designerName" in p) && !("intakeCurrency" in p));
});

test("取引モデルが混ざれば日付の見出しは発生日のまま", () => {
  const p = statementModelPatch(["sublicense", "in_house"]);
  assert.equal(p.transactionModel, "mixed");
  assert.equal(p.transactionModelLabel, "自社製造・自社販売／再許諾", "表の順で並べる");
  assert.ok(!("calcType" in p));
});

test("取引モデル概要：自社版・再許諾分・他社販売の版", () => {
  assert.equal(companyShortName("株式会社アークライト"), "アークライト");
  assert.equal(companyShortName("アークライト（株）"), "アークライト");
  assert.equal(modelSummaryLabel("in_house", "", "株式会社アークライト"), "アークライト版");
  assert.equal(modelSummaryLabel("sublicense", "Korea Board games Co., Ltd.", "株式会社アークライト"),
               "Korea Board games Co., Ltd.再許諾分");
  assert.equal(modelSummaryLabel("oem", "Korea Board games Co., Ltd.", "株式会社アークライト"),
               "Korea Board games Co., Ltd.版");
  // 会社情報が空でも「版」だけにはしない
  assert.equal(modelSummaryLabel("in_house", "", ""), "自社版");
  // 利用形態の分からない行は従来どおり相手の名前
  assert.equal(modelSummaryLabel(null, "Asmodee", "株式会社アークライト"), "Asmodee");
});

test("取引モデル概要：複数なら最初の1つ＋ほかN件（重なりは1つ）", () => {
  const company = "株式会社アークライト";
  assert.equal(modelSummary([{ usageType: "in_house" }, { usageType: "in_house" }], company), "アークライト版");
  assert.equal(modelSummary([
    { usageType: "in_house" },
    { usageType: "sublicense", payerName: "Korea Board games Co., Ltd." },
    { usageType: "sublicense", payerName: "Korea Board games Co., Ltd." },
    { usageType: "oem", payerName: "MM-Spiele" }
  ], company), "アークライト版 ほか2件");
});

const singleBase = {
  msrp: 1_000_000, quantity: 0, sampleQuantity: 0, ratePct: 10, mgAmount: 0, agAmount: 0,
  agConsumedBefore: 0, taxRatePct: 10, grossExTax: 100_000, mgTopupThisTime: 0, mgFloorApplied: false,
  agOffsetThisTime: 0, agRemainingAfter: 0, agFullyConsumed: false,
  actualExTax: 100_000, taxAmount: 10_000, totalIncTax: 110_000
};

test("単票：時限式（売上・受領額）は数量の欄を空にする（\"0\" だと本文の {{#if}} が真になる）", () => {
  const p = singleStatementPatch({ ...singleBase, calcType: "sublicense" });
  assert.equal(p.sampleQuantity, "");
  assert.equal(p.billableQuantity, "");
  assert.equal(p.msrpStr, "1,000,000", "基礎額は残す");
});

test("単票：製造時等は数量の欄を出す", () => {
  const p = singleStatementPatch({ ...singleBase, calcType: "manufacturing", quantity: 500, sampleQuantity: 20 });
  assert.equal(p.sampleQuantity, "20");
  assert.equal(p.billableQuantity, "480");
});

test("束ね：行の利用形態が rs_bundle_lines を通って出し分けに届く", () => {
  const lines = usageBundleLines([
    { eventId: 1, productName: "作品A", methodLabel: "自社製造・自社販売（基準価格 × 個数）",
      basis: 4_800_000, ratePct: 12.5, amount: 600_000, quantity: 400, sampleQuantity: 0, usageType: "in_house" }
  ]);
  assert.equal(lines[0].usageType, "in_house");
  // 保存（JSON）を通っても残る
  const saved = JSON.parse(JSON.stringify({ rs_bundle_lines: lines, rs_bundle_tax: 60_000 }));
  const ctx = { company: { name: "株式会社アークライト" }, condition: { counterparty: { name: "作家X" } } };
  const v = royaltyStatementPatch(ctx, saved, 10)!;
  assert.equal(v.transactionModel, "in_house");
  assert.equal(v.payerCompany, "アークライト版");
  assert.equal(v.designerName, "作家X", "権利者は今のまま");

  const mixed = royaltyStatementPatch(ctx, {
    rs_bundle_lines: [
      ...saved.rs_bundle_lines,
      { eventId: 2, conditionName: "作品A", methodLabel: "再許諾（受領価格）", salesJpy: 1_000_000,
        ratePct: 20, paymentJpy: 200_000, payerName: "Publisher Y", intakeCurrency: "USD", usageType: "sublicense" }
    ]
  }, 10)!;
  assert.equal(mixed.designerName, "作家X");
  assert.equal(mixed.payerCompany, "アークライト版 ほか1件");
  assert.equal(mixed.intakeCurrency, "USD", "入金通貨は今のまま（アウト条件の通貨）");

  const sub = royaltyStatementPatch(ctx, {
    rs_bundle_lines: [{ eventId: 3, conditionName: "作品A", methodLabel: "再許諾（受領価格）", salesJpy: 1_000_000,
      ratePct: 20, paymentJpy: 200_000, payerName: "Korea Board games Co., Ltd.", intakeCurrency: "JPY",
      usageType: "sublicense" }]
  }, 10)!;
  assert.equal(sub.payerCompany, "Korea Board games Co., Ltd.再許諾分");
});

test("束ね：利用形態の無い旧い行はこれまでどおり（受領情報も触らない）", () => {
  const v = royaltyStatementPatch({ condition: { counterparty: { name: "作家X" } } }, {
    rs_bundle_lines: [{ conditionId: 5, conditionName: "条件", methodLabel: "製造数量ベース",
                        salesJpy: 100, ratePct: 10, paymentJpy: 10 }]
  }, 10)!;
  assert.equal(v.designerName, "作家X");
  assert.ok(!("transactionModel" in v));
});
