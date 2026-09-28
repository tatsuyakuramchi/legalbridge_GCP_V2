// V2 から移植したテスト（apps/legalbridge/src/server/tax.test.ts）。
// 計算の意味論が移植で変わっていないことを固定する。落ちたら移植が壊れている。
import assert from "node:assert/strict";
import test from "node:test";
import {
  consumptionTax,
  resolveWithholdingEnabled,
  withholdingTax,
  computeRoyaltyPayment
} from "./tax.js";

test("消費税は切り捨て(税抜 × 税率/100)、既定10%・8%可・0円は0", () => {
  assert.equal(consumptionTax(10000), 1000);
  assert.equal(consumptionTax(8642), 864);     // 864.2 を切り捨て
  assert.equal(consumptionTax(10000, 8), 800);
  assert.equal(consumptionTax(0), 0);
  assert.equal(consumptionTax(1), 0);          // 0.1 を切り捨て
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

// ---- 非居住者と租税条約（A-057） ----

test("非居住者：国内法は一律 20.42%（居住者の段階税率ではない）", async () => {
  const { withholdingFor } = await import("./tax.js");
  const r = withholdingFor(1_500_000, true, { residency: "non_resident" }, "2026-10-31");
  assert.equal(r.amount, 306300);          // floor(1,500,000 × 20.42%)
  assert.equal(r.ratePct, 20.42);
  assert.equal(r.basis, "non_resident_domestic");
  // 居住者なら二段
  assert.equal(withholdingFor(1_500_000, true, { residency: "resident" }).amount, 204200);
});

test("非居住者：租税条約の書類が支払日までにあれば条約の税率（0% も）", async () => {
  const { withholdingFor } = await import("./tax.js");
  const party = { residency: "non_resident", treatyRatePct: 10, treatyDocsReceivedOn: "2026-10-01" };
  assert.deepEqual(withholdingFor(100000, true, party, "2026-10-31"),
    { amount: 10000, ratePct: 10, basis: "treaty" });
  // 書類が支払日の後 → 国内法
  assert.equal(withholdingFor(100000, true, party, "2026-09-30").amount, 20420);
  // 書類を受け取っていない → 国内法
  assert.equal(withholdingFor(100000, true, { residency: "non_resident", treatyRatePct: 10 }, "2026-10-31").amount, 20420);
  // 免除（0%）
  assert.equal(withholdingFor(100000, true, { ...party, treatyRatePct: 0 }, "2026-10-31").amount, 0);
  // 対象外なら 0
  assert.equal(withholdingFor(100000, false, party, "2026-10-31").amount, 0);
});

test("非居住者は個人でも自動では源泉の対象にしない（源泉の印を付けたときだけ）", () => {
  assert.equal(resolveWithholdingEnabled({ entityType: "individual", residency: "non_resident" }), false);
  assert.equal(resolveWithholdingEnabled({ entityType: "individual", residency: "non_resident", vendorWithholdingEnabled: true }), true);
  assert.equal(resolveWithholdingEnabled({ entityType: "individual", residency: "resident" }), true);
});

test("計算書の支払内訳も非居住者の税率で引く", () => {
  const r = computeRoyaltyPayment({ subtotalExTax: 100000, taxRatePct: 0, withholdingEnabled: true,
    withholdingParty: { residency: "non_resident" }, payOn: "2026-10-31" });
  assert.equal(r.consumptionTax, 0);
  assert.equal(r.withholdingTax, 20420);
  assert.equal(r.netTransfer, 79580);
});
