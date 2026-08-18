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

// ── 経費・手数料の精算込み（V1 の総支払額と同じ式）───────────────────
test("手数料は検収額と合算して一括課税、経費は税込のまま加算", () => {
  const totals = computeInspectionTotals({
    taxRate: "10",
    delivery_line_items: [{ inspected_amount_ex_tax: 100000 }],
    other_fees: [{ amount_ex_tax: 10000 }],
    expenses: [{ amount_inc_tax: 5500 }]
  });
  // (100,000 + 10,000) × 1.1 = 121,000 ＋ 経費 5,500 = 126,500
  assert.equal(totals.otherFeesExTax, 10000);
  assert.equal(totals.expensesIncTax, 5500);
  assert.equal(totals.grandTotalPayable, 126500);
  assert.equal(totals.hasSettlement, true);
});

test("精算なしなら総支払額＝税込合計で hasSettlement=false", () => {
  const totals = computeInspectionTotals({
    taxRate: "10", delivery_line_items: [{ inspected_amount_ex_tax: 100000 }]
  });
  assert.equal(totals.hasSettlement, false);
  assert.equal(totals.grandTotalPayable, totals.totalIncTax);
});

// 明細ごとの検収状態（ロジック再構成）: 支払額は今回検収（now）のみ。
// 検収済み（paid）は過去に支払済みなので今回の支払額に足さない。未検収（skip）は載らない。

test("状態別: 支払額は今回検収のみ・skip は行数にも入らない", () => {
  const totals = computeInspectionTotals({
    taxRate: "10",
    delivery_line_items: [
      { item_name: "今回", inspection_status: "now", inspected_amount_ex_tax: 25000 },
      { item_name: "過去分", inspection_status: "paid", inspected_amount_ex_tax: 100000, paid_date: "2026-08-31" },
      { item_name: "未検収", inspection_status: "skip", inspected_amount_ex_tax: 50000 }
    ]
  });
  assert.equal(totals.deliveredExTax, 25000);
  assert.equal(totals.tax, 2500);
  assert.equal(totals.totalIncTax, 27500);
  assert.equal(totals.lineCount, 2); // now + paid（PDFに載る行）
});

test("状態なしの旧下書きは全行 now 扱い（後方互換）", () => {
  const totals = computeInspectionTotals({
    taxRate: "10",
    delivery_line_items: [
      { item_name: "A", inspected_amount_ex_tax: 10000 },
      { item_name: "B", inspected_amount_ex_tax: 20000 }
    ]
  });
  assert.equal(totals.deliveredExTax, 30000);
});
