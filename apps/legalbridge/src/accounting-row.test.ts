import assert from "node:assert/strict";
import test from "node:test";
import { buildAccountingRow, fitSlots, ACCOUNTING_SLOT_COUNT } from "./accounting-row.js";

const vendor = {
  vendorCode: "2-20-3544", vendorName: "ドゥプラド ヤニック", vendorNameKana: "ドプラドヤニツク",
  entityType: "個人", withholdingEnabled: null, invoiceRegistrationNumber: null
};

test("計算書（かんたん受領入力・多明細）: 支払内容(1)に利用許諾料、小計・消費税・源泉（個人）・差引振込額が出る", () => {
  const row = buildAccountingRow("royalty_statement", {
    statementMode: "multi", rsInRatePct: 5, taxRate: "10", documentDate: "2026-09-04",
    originalWork: "ドキッと！アイス", licensor: "ドゥプラド ヤニック", STAFF_DEPARTMENT: "ボードゲーム事業部　海外ライツチーム",
    rs_receipts: [{ sublicensee: "Meridian Games", currency: "JPY", amount: 890000, fxMode: "post" }]
  }, vendor, "2026-09-18");
  assert.equal(row.title, "ドキッと！アイス 利用許諾料");
  assert.equal(row.paymentDate, "2026-09-18");
  assert.equal(row.department, "ボードゲーム事業部　海外ライツチーム");
  assert.equal(row.vendorCode, "2-20-3544");
  assert.equal(row.vendorNameKana, "ドプラドヤニツク");
  assert.equal(row.slots.length, ACCOUNTING_SLOT_COUNT);
  assert.equal(row.slots[0].content, "利用許諾料（ドキッと！アイス）");
  assert.equal(row.slots[0].amount, 44500);            // 890,000 × 5%（行ごと ceil）
  assert.equal(row.slots[0].deliveryDate, "2026-09-04");
  assert.equal(row.slots[1].content, "");
  assert.equal(row.subtotal, 44500);
  assert.equal(row.consumptionTax, 4450);
  assert.equal(row.withholdingEnabled, true);           // 個人 → 源泉あり
  assert.equal(row.withholdingTax, Math.floor(48950 * 0.1021));
  assert.equal(row.afterTax, 48950 - row.withholdingTax);
  assert.equal(row.reimbursement, 0);
  assert.equal(row.netTransfer, row.afterTax);
  assert.equal(row.invoiceRegistration, "");
});

test("計算書（束ね）: 契約ごとにスロットを分ける", () => {
  const row = buildAccountingRow("royalty_statement", {
    statementMode: "bundle", taxRate: 10,
    rs_bundle: [
      { conditionLineId: 1, contractTitle: "原作許諾", conditionName: "原作", calcType: "period", basisKind: "sales", msrp: 1000000, ratePct: 3 },
      { conditionLineId: 2, contractTitle: "イラスト許諾", conditionName: "イラスト", calcType: "period", basisKind: "sales", msrp: 500000, ratePct: 2 }
    ]
  }, { ...vendor, entityType: "法人", withholdingEnabled: false, invoiceRegistrationNumber: "T1234567890123" }, "2026-10-31");
  assert.equal(row.slots[0].content, "利用許諾料（原作許諾）");
  assert.equal(row.slots[0].amount, 30000);
  assert.equal(row.slots[1].content, "利用許諾料（イラスト許諾）");
  assert.equal(row.slots[1].amount, 10000);
  assert.equal(row.subtotal, 40000);
  assert.equal(row.withholdingTax, 0);                  // 法人・源泉OFF
  assert.equal(row.invoiceRegistration, "T1234567890123");
});

test("検収書: 今回検収の明細と課税の手数料がスロット、非課税・区分なし経費は立替金、9件目以降は8件目に束ねる", () => {
  const items = Array.from({ length: 9 }, (_, i) => ({ item_name: `明細${i + 1}`, unit_price: 1000, inspected_quantity: 1, inspected_amount_ex_tax: 1000, delivery_date: "2026-09-01", inspection_status: "now" }));
  const row = buildAccountingRow("inspection_certificate", {
    taxRate: 10, PROJECT_TITLE: "イラスト制作", inspectorDept: "編集部", counterparty: "スタジオ雨宿り",
    delivery_line_items: [...items, { item_name: "過去分", inspected_amount_ex_tax: 5000, inspection_status: "paid" }],
    other_fees: [{ fee_name: "振込手数料", amount: 440, tax_category: "taxable" }, { fee_name: "印紙", amount: 200, tax_category: "exempt" }],
    expenses: [{ expense_name: "交通費", amount_ex_tax: 20000, tax_category: "exempt" }, { expense_name: "旧経費", amount_inc_tax: 3300 }]
  }, { ...vendor, entityType: "法人", withholdingEnabled: false }, "2026-09-30");
  assert.equal(row.title, "イラスト制作");
  assert.equal(row.department, "編集部");
  // 9 明細 + 手数料 1 = 10 スロット → 8 に束ねる（8 件目に 明細8／明細9／振込手数料）
  assert.equal(row.slots[7].content, "明細8／明細9／振込手数料");
  assert.equal(row.slots[7].amount, 1000 + 1000 + 440);
  assert.equal(row.subtotal, 9000 + 440);
  assert.equal(row.reimbursement, 200 + 20000 + 3300);
  assert.equal(row.consumptionTax, Math.ceil(9440 * 0.1));
  assert.equal(row.netTransfer, 9440 + 944 + 23500);
});

test("fitSlots: 8 件以下は空スロットで埋める", () => {
  const slots = fitSlots([{ content: "A", unitPrice: "", quantity: "", amount: 1, deliveryDate: "" }]);
  assert.equal(slots.length, 8);
  assert.equal(slots[1].content, "");
});
