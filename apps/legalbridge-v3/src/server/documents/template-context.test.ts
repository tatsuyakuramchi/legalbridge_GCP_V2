import test from "node:test";
import assert from "node:assert/strict";
import {
  accountTypeLabel, bankInfoLine, buildTemplateContext, calcMethodOf, deliveryLinesFrom,
  lineFieldsFor, orderLinesFrom, rewardLabelOf, seedLines, suggestionsFor, taxRateFor
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

test("予定明細の無い分割納品でも、発注総額は条件の定額から出て未検収額が残る", () => {
  const context = ctx({
    conditions: [{ ...condition(), flatAmount: 1000000 }],
    condition: { ...condition(), flatAmount: 1000000 },
    events: [
      { id: 9, conditionId: 1, occurredOn: "2026-08-31", amount: 300000, plannedAmount: null, quantity: null, schedule: null },
      { id: 10, conditionId: 1, occurredOn: "2026-09-30", amount: 200000, plannedAmount: null, quantity: null, schedule: null }
    ]
  });
  const out = buildTemplateContext("inspection_certificate", context, {}) as Record<string, any>;
  assert.equal(out.totalOrderAmountStr, "1,000,000", "予定が無ければ条件の定額が発注総額");
  assert.equal(out.inspectedAmountStr, "500,000");
  assert.equal(out.pendingAmountStr, "500,000", "未検収額が 0 にならない");
  assert.equal(out.inspectedPct, 50);
});

test("検収書の行は、その条件から出た発注書の番号を持つ（条件をまたいでも行ごとに正しい）", () => {
  const context = ctx({
    conditions: [{ ...condition(), id: 1, conditionNo: "CL-1" }, { ...condition(), id: 2, conditionNo: "CL-2", name: "実費" }],
    related: [
      { id: 10, conditionId: 1, documentNo: "ARC-PO-2026-0031", templateKey: "purchase_order" },
      { id: 11, conditionId: 2, documentNo: "ARC-PO-2026-0033", templateKey: "purchase_order" },
      { id: 12, conditionId: 1, documentNo: "ARC-INS-2026-0001", templateKey: "inspection_certificate" }
    ],
    events: [
      { id: 9, conditionId: 1, occurredOn: "2026-08-31", amount: 100000, plannedAmount: null, quantity: null, schedule: null },
      { id: 10, conditionId: 2, occurredOn: "2026-09-05", amount: 12000, plannedAmount: null, quantity: null, schedule: null }
    ]
  });
  const lines = deliveryLinesFrom(context) as Array<Record<string, any>>;
  assert.equal(lines[0].order_no, "ARC-PO-2026-0031");
  assert.equal(lines[1].order_no, "ARC-PO-2026-0033");
  assert.equal(lines[1].condition_no, "CL-2");
});

test("検収の明細は、実績にあれば成果物と検収日を実績から取る", () => {
  const lines = deliveryLinesFrom(ctx({
    events: [
      { id: 9, conditionId: 1, occurredOn: "2026-08-31", amount: 280000, quantity: 1,
        deliverable: "第2回 キャラクターデザイン一式", inspectedOn: "2026-09-02",
        schedule: { seq: 2, label: "2026年8月分", dueOn: "2026-08-31", payOn: "2026-09-20" } },
      // 実績に成果物が無ければ、これまでどおり条件の名前を使う。
      { id: 10, conditionId: 1, occurredOn: "2026-09-30", amount: 280000, schedule: null }
    ]
  })) as Array<Record<string, any>>;
  assert.equal(lines.length, 2);
  assert.equal(lines[0].item_name, "第2回 キャラクターデザイン一式");
  assert.equal(lines[0].inspected_quantity, 1);
  assert.equal(lines[0].inspection_date, "2026-09-02");
  assert.equal(lines[0].paid_date, "2026-09-20", "支払日は繋がった予定から");
  assert.equal(lines[1].item_name, "アナログボードゲームの企画・開発");
  assert.equal(lines[1].inspection_date, "2026-09-30", "検収日が無ければ納品日");
  assert.equal(lines[1].paid_date, null, "予定に繋がっていない実績は支払日が空");
});

/**
 * 検収書の発注番号は、その条件から V3 で出した発注書の番号を使う。
 * V1・V2 や紙で出した発注書は V3 に文書として無いので、条件に控えた番号で代える。
 */
test("V3 の発注書が無ければ、条件に控えた発注番号を使う", () => {
  const lines = deliveryLinesFrom(ctx({
    conditions: [condition({ id: 1, orderNo: "ARC-PO-2025-0123" })],
    condition: condition({ id: 1, orderNo: "ARC-PO-2025-0123" }),
    related: [],
    events: [{ id: 9, conditionId: 1, occurredOn: "2026-08-31", amount: 280000, schedule: null }]
  })) as Array<Record<string, any>>;
  assert.equal(lines[0].order_no, "ARC-PO-2025-0123");
});

test("V3 の発注書があればそちらを使う（控えは使わない）", () => {
  const lines = deliveryLinesFrom(ctx({
    conditions: [condition({ id: 1, orderNo: "ARC-PO-2025-0123" })],
    condition: condition({ id: 1, orderNo: "ARC-PO-2025-0123" }),
    related: [{ conditionId: 1, templateKey: "purchase_order", documentNo: "ARC-PO-2026-0031" }],
    events: [{ id: 9, conditionId: 1, occurredOn: "2026-08-31", amount: 280000, schedule: null }]
  })) as Array<Record<string, any>>;
  assert.equal(lines[0].order_no, "ARC-PO-2026-0031");
});

test("控えも発注書も無ければ空のまま", () => {
  const lines = deliveryLinesFrom(ctx({
    related: [],
    events: [{ id: 9, conditionId: 1, occurredOn: "2026-08-31", amount: 280000, schedule: null }]
  })) as Array<Record<string, any>>;
  assert.equal(lines[0].order_no, null);
});

// ---------------------------------------------------------------------------
// 明細の支払方法と、業績連動の報酬の名前
// ---------------------------------------------------------------------------

test("条件の計算方式を、明細の支払方法に読み替える", () => {
  // 計算方式をそのまま大文字にしていたので "REVENUE_RATE" が入り、欄の選択肢
  // （FIXED / ROYALTY / SUBSCRIPTION）のどれにも当たらず、業績連動の枝が
  // 一度も開かなかった。
  assert.equal(calcMethodOf({ pricingModel: "revenue_rate" }), "ROYALTY");
  assert.equal(calcMethodOf({ pricingModel: "subscription" }), "SUBSCRIPTION");
  // 単価×数量は金額が先に決まる。業績連動ではない。
  assert.equal(calcMethodOf({ pricingModel: "unit_rate" }), "FIXED");
  assert.equal(calcMethodOf({ pricingModel: "fixed" }), "FIXED");
  assert.equal(calcMethodOf({ pricingModel: "none" }), "");
  assert.equal(calcMethodOf({}), "");
});

test("業績連動の報酬の名前は、成果物の帰属先で決まる", () => {
  const royalty = (owner: string | null) =>
    rewardLabelOf({ pricingModel: "revenue_rate", deliverableOwnership: owner });
  assert.equal(royalty("contractor"), "利用許諾料", "成果物は相手のもの。使う対価を払う");
  assert.equal(royalty("orderer"), "インセンティブ報酬", "成果物は当社のもの。売れたぶんを還元する");
  assert.equal(royalty(null), null, "帰属先が決まっていなければ名乗らない");
  // 業績連動でなければ、報酬の名前は要らない。
  assert.equal(rewardLabelOf({ pricingModel: "fixed", deliverableOwnership: "orderer" }), null);
});

test("検収書の納品明細に、支払方法と報酬の名前が入る", () => {
  const context = {
    conditions: [{ id: 5, name: "挿絵", pricingModel: "revenue_rate",
                   deliverableOwnership: "contractor", taxCategory: "taxable" }],
    events: [{ conditionId: 5, occurredOn: "2026-05-31", amount: 120000, quantity: 3 }]
  };
  const [line] = deliveryLinesFrom(context);
  assert.equal(line.calc_method, "ROYALTY");
  assert.equal(line.reward_label, "利用許諾料");
  assert.equal(line.deliverable_ownership, "受注者");
  // 金額は実績のまま。業績連動でも計算は別で行い、結果を人が入れる。
  assert.equal(line.inspected_amount_ex_tax, 120000);
});

test("支払日ごとにまとめても、業績連動の欄は行に残る", () => {
  // 本文は paymentGroups → this.lines を差す。ここで拾い落とすと、人が明細に
  // 入れた報酬の内訳がどこにも出ない（拾っていなかった）。
  const block = buildTemplateContext("inspection_certificate", {}, {
    delivery_line_items: [{
      item_name: "挿絵", inspected_amount_ex_tax: 120000, inspection_status: "paid",
      payment_date: "2026-06-30", calc_method: "ROYALTY", reward_label: "利用許諾料",
      rate_pct: "8", base_price_label: "上代 × 数量", formula_text: "上代1,500円 × 1,000部 × 8%",
      deliverable_ownership: "受注者"
    }]
  });
  const line = (block.paymentGroups as any[])[0].lines[0];
  assert.equal(line.reward_label, "利用許諾料");
  assert.equal(line.rate_pct, "8");
  assert.equal(line.base_price_label, "上代 × 数量");
  assert.equal(line.formula_text, "上代1,500円 × 1,000部 × 8%");
  assert.equal(line.deliverable_ownership, "受注者");
});

test("業績連動の行は、料率を条件から、算定根拠を実績のメモから引く", () => {
  // どちらも台帳に入っているのに紙まで届かず、人が明細へ打ち直していた。
  const [line] = deliveryLinesFrom({
    conditions: [{ id: 5, name: "挿絵", pricingModel: "revenue_rate", spec: "A4カラー10点",
                   deliverableOwnership: "contractor", ratePct: 8 }],
    events: [{ conditionId: 5, occurredOn: "2026-05-31", amount: 120000,
               note: "上代1,500円×1,000部×8%で算定" }]
  });
  assert.equal(line.rate_pct, 8);
  assert.equal(line.formula_text, "上代1,500円×1,000部×8%で算定");
});

test("仕様の欄がメモを使っているときは、算定根拠に同じ文を重ねない", () => {
  const [line] = deliveryLinesFrom({
    conditions: [{ id: 5, name: "挿絵", pricingModel: "revenue_rate",
                   deliverableOwnership: "contractor", ratePct: 8 }],
    events: [{ conditionId: 5, amount: 120000, note: "上代1,500円×1,000部×8%で算定" }]
  });
  assert.equal(line.spec, "上代1,500円×1,000部×8%で算定");
  assert.equal(line.formula_text, undefined);
});

test("定額の行には料率も算定根拠も出さない", () => {
  const [line] = deliveryLinesFrom({
    conditions: [{ id: 6, name: "組版", pricingModel: "fixed", ratePct: 8 }],
    events: [{ conditionId: 6, amount: 50000, note: "一式" }]
  });
  assert.equal(line.rate_pct, undefined);
  assert.equal(line.formula_text, undefined);
});

test("検収書の見出しの料率・帰属先は、条件が1件に決まるとき台帳から埋める", () => {
  // 本文は明細の外でも {{rate_pct}} と {{deliverable_ownership}} を差している。
  // 空のまま出すと「料率 ％」だけが残った紙になる。
  const context = {
    conditions: [{ id: 5, pricingModel: "revenue_rate",
                   deliverableOwnership: "contractor", ratePct: 8 }]
  };
  assert.deepEqual(suggestionsFor("inspection_certificate", context), {
    calc_method: "ROYALTY", deliverable_ownership: "受注者",
    reward_label: "利用許諾料", rate_pct: 8
  });
  assert.deepEqual(suggestionsFor("purchase_order", context), {
    calc_method: "ROYALTY", deliverable_ownership: "受注者",
    reward_label: "利用許諾料", rate_pct: 8
  });
});

test("条件が複数なら見出しの料率は埋めない（行ごとに違う）", () => {
  assert.deepEqual(suggestionsFor("inspection_certificate", {
    conditions: [{ id: 5, pricingModel: "revenue_rate", ratePct: 8 },
                 { id: 6, pricingModel: "revenue_rate", ratePct: 5 }]
  }), {});
});
