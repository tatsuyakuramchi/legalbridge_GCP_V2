import test from "node:test";
import assert from "node:assert/strict";
import { STATEMENT_MODELS, statementModelPatch } from "./statement-model.js";
import { USAGE_TYPES } from "./usage-type.js";
import { royaltyStatementPatch, singleStatementPatch, usageBundleLines } from "../documents/royalty-patch.js";

test("表は利用形態を全部持つ", () => {
  assert.deepEqual(STATEMENT_MODELS.map((m) => m.usageType).sort(), USAGE_TYPES.map((t) => t.value).sort());
});

test("利用形態が分からなければ何も変えない", () => {
  assert.deepEqual(statementModelPatch([]), {});
  assert.deepEqual(statementModelPatch([null, "unknown"]), {});
});

test("自社製造・自社販売だけなら、受領情報（サブライセンス入金）の欄を空にする", () => {
  const p = statementModelPatch(["in_house", "in_house"]);
  assert.equal(p.transactionModel, "in_house");
  assert.equal(p.transactionModelLabel, "自社製造・自社販売");
  assert.equal(p.hasReceiptBlock, false);
  assert.equal(p.calcType, "manufacturing", "日付の見出しは製造完了日");
  assert.equal(p.payerCompany, "");
  assert.equal(p.designerName, "");
  assert.equal(p.intakeCurrency, "");
});

test("相手からの入金がある形が混ざれば、受領情報は残す", () => {
  const p = statementModelPatch(["sublicense", "in_house"]);
  assert.equal(p.transactionModel, "mixed");
  assert.equal(p.transactionModelLabel, "自社製造・自社販売／再許諾", "表の順で並べる");
  assert.equal(p.hasReceiptBlock, true);
  assert.ok(!("payerCompany" in p));
  assert.ok(!("calcType" in p), "混ざれば日付の見出しは発生日のまま");
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
  const v = royaltyStatementPatch({ condition: { counterparty: { name: "作家X" } } }, saved, 10)!;
  assert.equal(v.transactionModel, "in_house");
  assert.equal(v.designerName, "", "自社販売だけなので受領情報は出さない");

  const mixed = royaltyStatementPatch({ condition: { counterparty: { name: "作家X" } } }, {
    rs_bundle_lines: [
      ...saved.rs_bundle_lines,
      { eventId: 2, conditionName: "作品A", methodLabel: "再許諾（受領価格）", salesJpy: 1_000_000,
        ratePct: 20, paymentJpy: 200_000, payerName: "Publisher Y", intakeCurrency: "USD", usageType: "sublicense" }
    ]
  }, 10)!;
  assert.equal(mixed.designerName, "作家X");
  assert.equal(mixed.payerCompany, "Publisher Y");
});

test("束ね：利用形態の無い旧い行はこれまでどおり（受領情報も触らない）", () => {
  const v = royaltyStatementPatch({ condition: { counterparty: { name: "作家X" } } }, {
    rs_bundle_lines: [{ conditionId: 5, conditionName: "条件", methodLabel: "製造数量ベース",
                        salesJpy: 100, ratePct: 10, paymentJpy: 10 }]
  }, 10)!;
  assert.equal(v.designerName, "作家X");
  assert.ok(!("transactionModel" in v));
});
