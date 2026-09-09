import test from "node:test";
import assert from "node:assert/strict";
import {
  accountTypeLabel, bankInfoLine, buildTemplateContext, deliveryLinesFrom, lineFieldsFor, orderLinesFrom, seedLines, taxRateFor
} from "./template-context.js";
import { computeInspectionTotals, inspectionTaxBreakdown, purchaseOrderTotals } from "./legacy-totals.js";

const condition = (over: Record<string, any> = {}) => ({
  id: 1, name: "アナログボードゲームの企画・開発", notes: "（1）専門的助言（2）レビュー",
  taxCategory: "taxable", pricingModel: "flat", flatAmount: 280000, termEnd: "2027-03-31",
  ...over
});

const ctx = (over: Record<string, any> = {}) => ({
  document: { number: "ARC-INS-2026-0072", issuedOn: "2026-09-08" },
  conditions: [condition()],
  condition: condition(),
  events: [{ id: 9, conditionId: 1, occurredOn: "2026-08-31", amount: 280000,
             plannedAmount: 280000, quantity: null,
             schedule: { payOn: "2026-09-20", dueOn: "2026-08-31" } }],
  schedules: [],
  bank: { bankName: "三菱UFJ銀行", branchName: "神保町支店", accountType: "ordinary",
          accountNumber: "2513200", holderKana: "ヨシザワ　アツオ" },
  ...over
});

// ---- 消費税 ------------------------------------------------------------

test("検収書の消費税は実績の税抜額から出る（切り上げ）", () => {
  const c = buildTemplateContext("inspection_certificate", ctx(), {});
  assert.equal(c.taxRate, 10);
  assert.equal(c.deliveredAmountStr, "280,000");
  assert.equal(c.taxAmountStr, "28,000");
  assert.equal(c.totalAmountStr, "308,000");
});

test("端数は切り上げる（V1 と同じ）", () => {
  const c = buildTemplateContext("inspection_certificate",
    ctx({ events: [{ id: 1, conditionId: 1, occurredOn: "2026-08-31", amount: 33333,
                     schedule: null }] }), {});
  // 33333 × 10% = 3333.3 → 3334
  assert.equal(c.taxAmountStr, "3,334");
  assert.equal(c.totalAmountStr, "36,667");
});

test("軽減税率と非課税は税区分から決まる", () => {
  const reduced = buildTemplateContext("inspection_certificate",
    ctx({ conditions: [condition({ taxCategory: "reduced" })],
          condition: condition({ taxCategory: "reduced" }) }), {});
  assert.equal(reduced.taxRate, 8);
  assert.equal(reduced.taxAmountStr, "22,400");

  const exempt = buildTemplateContext("inspection_certificate",
    ctx({ conditions: [condition({ taxCategory: "exempt" })],
          condition: condition({ taxCategory: "exempt" }) }), {});
  assert.equal(exempt.taxRate, 0);
  assert.equal(exempt.taxAmountStr, "0");
  assert.equal(exempt.totalAmountStr, "280,000");
});

test("税率を手で指定したらそちらが勝つ", () => {
  const c = buildTemplateContext("inspection_certificate", ctx(), { taxRate: "0" });
  assert.equal(c.taxRate, 0, "明示された0%を10%に戻さない");
  assert.equal(c.taxAmountStr, "0");
});

test("手数料は検収額と合算して一括課税、経費は税込のまま足す", () => {
  const c = buildTemplateContext("inspection_certificate", ctx(), {
    other_fees: [{ amount_ex_tax: 20000 }],
    expenses: [{ amount_inc_tax: 1100 }]
  });
  // (280000 + 20000) × 10% = 30000
  assert.equal(c.taxableSubtotalExTaxStr, "300,000");
  assert.equal(c.combinedTaxStr, "30,000");
  assert.equal(c.taxableTotalIncTaxStr, "330,000");
  assert.equal(c.grandTotalPayableStr, "331,100");
});

// ---- 明細 --------------------------------------------------------------

test("検収の明細は実績から組む（人が打ち直さない）", () => {
  const lines = deliveryLinesFrom(ctx()) as Array<Record<string, any>>;
  assert.equal(lines.length, 1);
  assert.equal(lines[0].delivery_date, "2026-08-31");
  assert.equal(lines[0].payment_date, "2026-09-20", "支払日は予定明細の支払期日");
  assert.equal(lines[0].amount_ex_tax, 280000);
  assert.equal(lines[0].spec, "（1）専門的助言（2）レビュー");
  assert.equal(lines[0].inspection_status, "now");
});

test("実績を選ばないときは条件そのものを1行にする", () => {
  const lines = deliveryLinesFrom(ctx({ events: [] })) as Array<Record<string, any>>;
  assert.equal(lines.length, 1);
  assert.equal(lines[0].amount_ex_tax, 280000);
});

test("発注の明細は予定から組む", () => {
  const lines = orderLinesFrom(ctx({
    schedules: [
      { id: 1, conditionId: 1, seq: 1, label: "第1回 着手金", plannedAmount: 100000,
        dueOn: "2026-04-30", payOn: "2026-05-31" },
      { id: 2, conditionId: 1, seq: 2, label: "第2回 納品時", plannedAmount: 180000,
        dueOn: "2026-08-31", payOn: "2026-09-30" }
    ]
  })) as Array<Record<string, any>>;
  assert.equal(lines.length, 2);
  assert.equal(lines[0].item_name, "第1回 着手金");
  assert.equal(purchaseOrderTotals({ items: lines }).grandTotalExTax, 280000);
});

test("予定額と違えば変更履歴に出す", () => {
  const c = buildTemplateContext("inspection_certificate", ctx({
    events: [{ id: 9, conditionId: 1, occurredOn: "2026-08-31", amount: 250000,
               plannedAmount: 280000, schedule: null }]
  }), {});
  assert.equal(c.hasChangeLogs, true);
  const logs = c.changeLogs as Array<Record<string, string>>;
  assert.equal(logs[0].beforeValue, "¥280,000");
  assert.equal(logs[0].afterValue, "¥250,000");
});

test("手で直した明細は計算で消さない", () => {
  const c = buildTemplateContext("inspection_certificate", ctx(), {
    delivery_line_items: [{ item_name: "手で足した行", amount_ex_tax: 500 }]
  });
  assert.equal(c.deliveredAmountStr, "500");
  assert.equal((c.delivery_line_items as unknown[]).length, 1);
});

// ---- 振込先 ------------------------------------------------------------

test("振込先は項目ごとにも1行にも出る", () => {
  const c = buildTemplateContext("inspection_certificate", ctx(), {});
  assert.equal(c.BANK_NAME, "三菱UFJ銀行");
  assert.equal(c.BRANCH_NAME, "神保町支店");
  assert.equal(c.ACCOUNT_TYPE, "普通");
  assert.equal(c.ACCOUNT_NUMBER, "2513200");
  assert.equal(c.ACCOUNT_HOLDER_KANA, "ヨシザワ　アツオ");
  assert.equal(c.BANK_INFO, "三菱UFJ銀行 / 神保町支店 / 普通 2513200 / ヨシザワ　アツオ");
});

test("口座が無くても書類は作れる（空で出る）", () => {
  const c = buildTemplateContext("inspection_certificate", ctx({ bank: null }), {});
  assert.equal(c.BANK_INFO, "");
  assert.equal(c.BANK_NAME, "");
});

test("口座種別は日本語にする", () => {
  assert.equal(accountTypeLabel("ordinary"), "普通");
  assert.equal(accountTypeLabel("checking"), "当座");
  assert.equal(accountTypeLabel("普通"), "普通");
  assert.equal(accountTypeLabel(""), "");
  assert.equal(bankInfoLine(null), "");
});

// ---- 発注書 ------------------------------------------------------------

test("発注書は明細の合計と日付のまとめを出す", () => {
  const c = buildTemplateContext("purchase_order", ctx({
    schedules: [
      { id: 1, conditionId: 1, seq: 1, label: "第1回", plannedAmount: 100000,
        dueOn: "2026-04-30", payOn: "2026-05-31" },
      { id: 2, conditionId: 1, seq: 2, label: "第2回", plannedAmount: 180000,
        dueOn: "2026-08-31", payOn: "2026-09-30" }
    ]
  }), {});
  assert.equal(c.grandTotalExTax, 280000);
  assert.equal(c.grandTotalExTaxStr, "280,000");
  assert.equal(c.summaryDeliveryDate, "2026-04-30 〜 2026-08-31 (明細参照)");
  assert.equal(c.summaryPaymentDate, "2026-05-31 〜 2026-09-30 (明細参照)");
});

// ---- 税区分の内訳 ------------------------------------------------------

test("税区分の内訳は区分ごとに端数処理する", () => {
  const b = inspectionTaxBreakdown({
    delivery_line_items: [{ amount_ex_tax: 10001 }],
    other_fees: [{ amount_ex_tax: 10001, tax_category: "reduced" }],
    expenses: [{ amount_inc_tax: 500 }],
    taxRate: 10
  });
  assert.equal(b.taxable10, 10001);
  assert.equal(b.reduced8, 10001);
  assert.equal(b.legacyIncTax, 500, "区分の無い旧データは勝手に区分しない");
  // ceil(10001×10%)=1001, ceil(10001×8%)=801
  assert.equal(b.tax, 1802);
  assert.equal(b.totalIncTax, 10001 + 10001 + 1802 + 500);
});

test("税率が未入力のときだけ10%に戻す", () => {
  assert.equal(computeInspectionTotals({ delivery_line_items: [{ amount_ex_tax: 100 }] }).taxRate, 10);
  assert.equal(computeInspectionTotals({ delivery_line_items: [], taxRate: 0 }).taxRate, 0);
});

test("税率は条件の区分から決まる（混在は高いほうを表示率にする）", () => {
  assert.equal(taxRateFor(ctx(), {}), 10);
  assert.equal(taxRateFor(ctx({ conditions: [condition({ taxCategory: "exempt" })] }), {}), 0);
  assert.equal(taxRateFor(ctx({
    conditions: [condition({ taxCategory: "exempt" }), condition({ taxCategory: "reduced" })]
  }), {}), 8);
});

test("発注の行は 1 × 金額 を単価に置く（本文が「¥0」を印字しないように）", () => {
  const lines = orderLinesFrom(ctx({ schedules: [], conditions: [
    { id: 1, name: "翻訳", flatAmount: 100000, pricingModel: "fixed", taxCategory: "taxable" }
  ] })) as Array<Record<string, any>>;
  assert.equal(lines[0].quantity, 1);
  assert.equal(lines[0].unit_price, 100000);
  assert.equal(lines[0].amount_ex_tax, 100000);
});

test("明細の欄はひな形で決まり、種の行は条件・実績から組む", () => {
  assert.deepEqual(lineFieldsFor("purchase_order"), ["items", "other_fees", "expenses"]);
  assert.deepEqual(lineFieldsFor("inspection_certificate"), ["delivery_line_items", "other_fees", "expenses"]);
  assert.deepEqual(lineFieldsFor("license_master"), []);
  const seeds = seedLines("purchase_order", ctx({ schedules: [], conditions: [
    { id: 1, name: "翻訳", flatAmount: 100000, pricingModel: "fixed", taxCategory: "taxable" }
  ] }));
  assert.equal(seeds.items.length, 1);
  assert.deepEqual(seeds.other_fees, []);
});

test("条件の仕様と帰属先が明細の行に出る。仕様が無ければ備考で代える", () => {
  const withSpec = orderLinesFrom(ctx({ schedules: [], conditions: [
    { id: 1, name: "翻訳", flatAmount: 100000, pricingModel: "fixed", taxCategory: "taxable",
      spec: "全章の英訳", notes: "備考", deliverableOwnership: "orderer" }
  ] })) as Array<Record<string, any>>;
  assert.equal(withSpec[0].spec, "全章の英訳");
  assert.equal(withSpec[0].deliverable_ownership, "発注者");
  const fallback = orderLinesFrom(ctx({ schedules: [], conditions: [
    { id: 1, name: "翻訳", flatAmount: 100000, pricingModel: "fixed", taxCategory: "taxable", notes: "備考だけ" }
  ] })) as Array<Record<string, any>>;
  assert.equal(fallback[0].spec, "備考だけ");
  assert.equal(fallback[0].deliverable_ownership, null);
});
