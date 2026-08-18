import assert from "node:assert/strict";
import test from "node:test";
import { computeInspectionTotals, formatYen } from "./inspection-totals.js";

// フォームの合計パネルと PDF が同じ関数を通る（画面と PDF の合計一致の要）。
test("明細合計→切り上げ消費税→税込合計", () => {
  const totals = computeInspectionTotals({
    taxRate: "10",
    delivery_line_items: [
      { inspected_amount_ex_tax: 100000 },
      { inspected_amount_ex_tax: 50000 },
      { inspected_amount_ex_tax: 0, calc_method: "ROYALTY" }
    ]
  });
  assert.equal(totals.deliveredExTax, 150000);
  assert.equal(totals.tax, 15000);
  assert.equal(totals.totalIncTax, 165000);
  assert.equal(totals.lineCount, 3);
});

test("端数は切り上げ（既存の検収税計算と同じ）", () => {
  const totals = computeInspectionTotals({ taxRate: 10, delivery_line_items: [{ inspected_amount_ex_tax: 333 }] });
  assert.equal(totals.tax, 34);
  assert.equal(totals.totalIncTax, 367);
});

test("カンマ入り文字列・列名ゆれ（amount_ex_tax / amount）も読む", () => {
  const totals = computeInspectionTotals({
    delivery_line_items: [{ inspected_amount_ex_tax: "1,000" }, { amount_ex_tax: 500 }, { amount: 250 }]
  });
  assert.equal(totals.deliveredExTax, 1750);
});

test("税率未入力は10%・明細なしは0件", () => {
  assert.equal(computeInspectionTotals({ delivery_line_items: [{ inspected_amount_ex_tax: 100 }] }).taxRate, 10);
  assert.equal(computeInspectionTotals({}).lineCount, 0);
});

test("表示整形は日本語ロケールの桁区切り", () => {
  assert.equal(formatYen(1234567), "1,234,567");
});
