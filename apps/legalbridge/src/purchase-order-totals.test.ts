import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateItemDates, lineAmountExTax, purchaseOrderTotals, withPurchaseOrderTotals
} from "./purchase-order-totals.js";

test("明細の金額は金額欄を優先し、無ければ単価×数量で補う", () => {
  assert.equal(lineAmountExTax({ amount_ex_tax: 50000, unit_price: 999, quantity: 999 }), 50000);
  assert.equal(lineAmountExTax({ unit_price: 30000, quantity: 3 }), 90000);
  // 数量未入力は1個として扱う（V1 の既定）。
  assert.equal(lineAmountExTax({ unit_price: 30000 }), 30000);
  assert.equal(lineAmountExTax({}), 0);
  // 文字列で入ってくる（input の値）ケース。
  assert.equal(lineAmountExTax({ unit_price: "1000", quantity: "2" }), 2000);
});

test("合計金額は明細小計＋手数料小計", () => {
  const totals = purchaseOrderTotals({
    items: [{ amount_ex_tax: 100000 }, { unit_price: 20000, quantity: 2 }],
    other_fees: [{ amount: 5000 }, { amount: 3000 }]
  });
  assert.equal(totals.itemsSubtotalExTax, 140000);
  assert.equal(totals.otherFeesTotal, 8000);
  assert.equal(totals.grandTotalExTax, 148000);
});

test("業績連動で金額0の明細は合計に載らない", () => {
  // 金額0＝「報酬は利用許諾料に含む」。確定額ではないので小計に足さない。
  const totals = purchaseOrderTotals({
    items: [
      { item_name: "執筆", calc_method: "ROYALTY", amount_ex_tax: 30000 },
      { item_name: "監修", calc_method: "ROYALTY", amount_ex_tax: 0 }
    ]
  });
  assert.equal(totals.grandTotalExTax, 30000);
});

test("明細も手数料も無ければ 0", () => {
  assert.deepEqual(purchaseOrderTotals({}),
    { itemsSubtotalExTax: 0, otherFeesTotal: 0, grandTotalExTax: 0 });
  assert.deepEqual(purchaseOrderTotals({ items: [], other_fees: null }),
    { itemsSubtotalExTax: 0, otherFeesTotal: 0, grandTotalExTax: 0 });
});

test("納期・支払日は全同日ならその日付、複数なら範囲表記", () => {
  const items = [{ delivery_date: "2026-09-30" }, { delivery_date: "2026-09-30" }];
  assert.equal(aggregateItemDates(items, "delivery_date"), "2026-09-30");
  const mixed = [{ delivery_date: "2026-10-31" }, { delivery_date: "2026-09-30" }];
  assert.equal(aggregateItemDates(mixed, "delivery_date"), "2026-09-30 〜 2026-10-31 (明細参照)");
  assert.equal(aggregateItemDates(mixed, "delivery_date", true), "2026-09-30 – 2026-10-31 (see details)");
  assert.equal(aggregateItemDates([], "delivery_date"), "");
  assert.equal(aggregateItemDates([{ delivery_date: "  " }], "delivery_date"), "");
});

test("定期支払の明細は日付集約から除く（期間と支払日サイクルで表すため）", () => {
  const items = [
    { calc_method: "FIXED", delivery_date: "2026-09-30" },
    { calc_method: "SUBSCRIPTION", delivery_date: "2030-01-01", term_start: "2026-04-01" }
  ];
  assert.equal(aggregateItemDates(items, "delivery_date"), "2026-09-30");
});

test("フォームへ書き戻すと合計・納期・支払日が入る", () => {
  const next = withPurchaseOrderTotals("purchase_order", {
    items: [{ amount_ex_tax: 100000, delivery_date: "2026-09-30", payment_date: "2026-10-31" }],
    other_fees: [{ amount: 5000 }]
  });
  assert.equal(next.itemsSubtotalExTax, 100000);
  assert.equal(next.otherFeesTotal, 5000);
  assert.equal(next.grandTotalExTax, 105000);
  assert.equal(next.summaryDeliveryDate, "2026-09-30");
  assert.equal(next.summaryPaymentDate, "2026-10-31");
});

test("明細が無い発注書は手入力の合計金額を残す", () => {
  // 明細表を使わない運用（単一明細フォールバック）が V1 から残っている。
  const next = withPurchaseOrderTotals("purchase_order", { grandTotalExTax: 250000 });
  assert.equal(next.grandTotalExTax, 250000);
  assert.equal(next.summaryDeliveryDate, undefined);
});

test("明細を入れたら手入力の合計金額は集計値で上書きする", () => {
  const next = withPurchaseOrderTotals("purchase_order", {
    grandTotalExTax: 999999, items: [{ amount_ex_tax: 100000 }]
  });
  assert.equal(next.grandTotalExTax, 100000);
});

test("海外発注書は納期キーを summaryCompletionDate にも入れる", () => {
  const next = withPurchaseOrderTotals("intl_purchase_order", {
    items: [{ amount_ex_tax: 1000, delivery_date: "2026-09-30" }]
  });
  assert.equal(next.summaryCompletionDate, "2026-09-30");
  assert.equal(next.summaryDeliveryDate, "2026-09-30");
});

test("発注書以外のテンプレートには一切触らない", () => {
  const formData = { items: [{ amount_ex_tax: 100000 }], grandTotalExTax: 1 };
  assert.equal(withPurchaseOrderTotals("inspection_certificate", formData), formData);
});
