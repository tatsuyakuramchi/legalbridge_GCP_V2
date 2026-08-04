import assert from "node:assert/strict";
import test from "node:test";
import { convertToJpy, computeStatementLine } from "./fx.js";

test("円換算：JPYはそのままround、外貨はround(額×レート)、レート0は0", () => {
  assert.equal(convertToJpy(1000, "USD", 150), 150000);
  assert.equal(convertToJpy(1000, "JPY", 0), 1000);
  assert.equal(convertToJpy(1000, "USD", 0), 0);      // foreign かつレート未入力
  assert.equal(convertToJpy(1234.5, "EUR", 160), 197520);
  assert.equal(convertToJpy(100, "jpy", 150), 100);   // 大小文字無視でJPY扱い
  assert.equal(convertToJpy(100.6, "JPY", 0), 101);   // round
  assert.equal(convertToJpy(100.4, "JPY", 0), 100);
});

test("売上報告型明細：base=円換算、支払=ceil(base×料率)", () => {
  const usd = computeStatementLine({ method: "revenue", salesInput: 1000, intakeCurrency: "USD", fxRate: 150, ratePct: 10 });
  assert.equal(usd.salesJpy, 150000);
  assert.equal(usd.paymentJpy, 15000);

  // JPY・端数切上：99999 × 7% = 6999.93 → 7000
  const jpy = computeStatementLine({ method: "revenue", salesInput: 99999, intakeCurrency: "JPY", ratePct: 7 });
  assert.equal(jpy.salesJpy, 99999);
  assert.equal(jpy.paymentJpy, 7000);

  // 外貨・レート未入力 → base0・支払0
  const noRate = computeStatementLine({ method: "revenue", salesInput: 5000, intakeCurrency: "USD", fxRate: 0, ratePct: 10 });
  assert.equal(noRate.salesJpy, 0);
  assert.equal(noRate.paymentJpy, 0);
});

test("製造型明細：base=round(単価×billable)、支払=ceil(単価×billable×料率)", () => {
  const r = computeStatementLine({ method: "manufacturing", unitPrice: 500, qty: 100, sample: 10, ratePct: 8 });
  assert.equal(r.salesJpy, 45000);   // 500×90
  assert.equal(r.paymentJpy, 3600);  // ceil(500×90×8/100)

  // 支払は丸め前の積からceil：333×3×5% = 49.95 → 50
  const odd = computeStatementLine({ method: "manufacturing", unitPrice: 333, qty: 3, sample: 0, ratePct: 5 });
  assert.equal(odd.salesJpy, 999);
  assert.equal(odd.paymentJpy, 50);
});
