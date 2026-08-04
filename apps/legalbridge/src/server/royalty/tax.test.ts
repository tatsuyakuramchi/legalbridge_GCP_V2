import assert from "node:assert/strict";
import test from "node:test";
import {
  consumptionTax,
  resolveWithholdingEnabled,
  withholdingTax,
  computeRoyaltyPayment
} from "./tax.js";

test("消費税は ceil(税抜 × 税率/100)、既定10%・8%可・0円は0", () => {
  assert.equal(consumptionTax(10000), 1000);
  assert.equal(consumptionTax(8642), 865);     // ceil(864.2)
  assert.equal(consumptionTax(10000, 8), 800);
  assert.equal(consumptionTax(0), 0);
  assert.equal(consumptionTax(1), 1);          // ceil(0.1)
});

test("源泉対象判定：vendor有効 / 個人 / フォーム上書き のいずれかで対象", () => {
  assert.equal(resolveWithholdingEnabled({ vendorWithholdingEnabled: true }), true);
  assert.equal(resolveWithholdingEnabled({ entityType: "個人" }), true);
  assert.equal(resolveWithholdingEnabled({ entityType: "individual" }), true);
  assert.equal(resolveWithholdingEnabled({ formOverride: true }), true);
  // 法人・未設定は対象外
  assert.equal(resolveWithholdingEnabled({ entityType: "法人" }), false);
  assert.equal(resolveWithholdingEnabled({ vendorWithholdingEnabled: false, entityType: "法人" }), false);
  assert.equal(resolveWithholdingEnabled({}), false);
});

test("源泉税：非対象/0以下は0、100万以下は10.21%floor", () => {
  assert.equal(withholdingTax(500000, false), 0);   // 非対象
  assert.equal(withholdingTax(0, true), 0);
  assert.equal(withholdingTax(-100, true), 0);
  assert.equal(withholdingTax(500000, true), 51050);   // floor(500000×0.1021)
  assert.equal(withholdingTax(1000000, true), 102100); // 境界 floor(1000000×0.1021)
});

test("源泉税：100万超は二段階 floor(100万×10.21%) + floor(超過×20.42%)", () => {
  // 1,500,000 → 102100 + floor(500000×0.2042)=102100 → 204200
  assert.equal(withholdingTax(1500000, true), 204200);
  // 1,234,567 → 102100 + floor(234567×0.2042)=floor(47898.5814)=47898 → 149998
  assert.equal(withholdingTax(1234567, true), 149998);
});

test("支払内訳：税抜→+消費税→税込→−源泉→+立替→振込額", () => {
  // subtotal 100000, 10%, 対象, 立替0
  const r = computeRoyaltyPayment({ subtotalExTax: 100000, withholdingEnabled: true });
  assert.equal(r.consumptionTax, 10000);
  assert.equal(r.taxIncluded, 110000);
  assert.equal(r.withholdingTax, 11231);  // floor(110000×0.1021)
  assert.equal(r.afterTax, 98769);
  assert.equal(r.netTransfer, 98769);

  // 立替金（税込）を加算
  const withReimb = computeRoyaltyPayment({ subtotalExTax: 100000, withholdingEnabled: true, reimbursementIncTax: 5000 });
  assert.equal(withReimb.netTransfer, 103769);

  // 非対象なら源泉0・振込=税込
  const noWh = computeRoyaltyPayment({ subtotalExTax: 100000, withholdingEnabled: false });
  assert.equal(noWh.withholdingTax, 0);
  assert.equal(noWh.netTransfer, 110000);
});
