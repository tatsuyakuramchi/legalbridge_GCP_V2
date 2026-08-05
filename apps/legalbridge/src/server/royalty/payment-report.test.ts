import assert from "node:assert/strict";
import test from "node:test";
import { buildPaymentReport, type PaymentReportInput } from "./payment-report.js";

function input(over: Partial<PaymentReportInput>): PaymentReportInput {
  return {
    paymentId: 1, vendorName: "取引先X", vendorCode: "V-1", entityType: "法人",
    vendorWithholdingEnabled: false, invoiceRegistrationNumber: "T123", period: "2026-08",
    currency: "JPY", amountExTax: 100000, taxRatePct: 10, ...over
  };
}

test("源泉対象外：消費税のみ、振込=税込", () => {
  const r = buildPaymentReport([input({ amountExTax: 100000 })]);
  const line = r.lines[0];
  assert.equal(line.consumptionTax, 10000);
  assert.equal(line.taxIncluded, 110000);
  assert.equal(line.withholdingTax, 0);
  assert.equal(line.netTransfer, 110000);
});

test("源泉対象（個人）：税込に10.21%源泉、差引振込", () => {
  const r = buildPaymentReport([input({ entityType: "個人", amountExTax: 100000 })]);
  const line = r.lines[0];
  assert.equal(line.withholdingEnabled, true);
  assert.equal(line.taxIncluded, 110000);
  assert.equal(line.withholdingTax, 11231);  // floor(110000×0.1021)
  assert.equal(line.netTransfer, 98769);
});

test("合計を集計する", () => {
  const r = buildPaymentReport([
    input({ paymentId: 1, entityType: "法人", amountExTax: 100000 }),   // 源泉0
    input({ paymentId: 2, entityType: "個人", amountExTax: 100000 })    // 源泉11231
  ]);
  assert.equal(r.totals.count, 2);
  assert.equal(r.totals.subtotalExTax, 200000);
  assert.equal(r.totals.consumptionTax, 20000);
  assert.equal(r.totals.withholdingTax, 11231);
  assert.equal(r.totals.netTransfer, 110000 + 98769);
});

test("vendor未設定はプレースホルダ表示", () => {
  const r = buildPaymentReport([input({ vendorName: null })]);
  assert.equal(r.lines[0].vendorName, "（取引先未設定）");
});
