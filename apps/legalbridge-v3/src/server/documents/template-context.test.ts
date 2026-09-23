import test from "node:test";
import assert from "node:assert/strict";
import {
  accountTypeLabel, bankInfoLine, buildTemplateContext, calcMethodOf, deliveryLinesFrom,
  lineFieldsFor, orderLinesFrom, rewardLabelOf, seedLines, splitSpec, suggestionsFor, summarizeDates, taxRateFor
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

/**
 * 予定明細の無い業務委託でも、記録のときに確かめた額（expected）と実額が違えば
 * 変更履歴に出し、相手の確認欄（署名）を出す。理由は差分の記録から。
 */
test("予定が無くても記録時の確認額と違えば変更履歴と署名欄を出す", () => {
  const c = buildTemplateContext("inspection_certificate", ctx({
    events: [{ id: 9, conditionId: 1, occurredOn: "2026-09-20", amount: 30000,
               plannedAmount: null, expectedAmount: 50000, varianceNote: "5点中3点の納品。残りは待たず減額で終了",
               schedule: null }]
  }), {});
  assert.equal(c.hasChangeLogs, true);
  assert.equal(c.needsSignature, true);
  const logs = c.changeLogs as Array<Record<string, string>>;
  assert.equal(logs[0].beforeValue, "¥50,000");
  assert.equal(logs[0].afterValue, "¥30,000");
  assert.equal(logs[0].reason, "5点中3点の納品。残りは待たず減額で終了");
});

test("額が変わっていなければ署名欄は出ない", () => {
  const c = buildTemplateContext("inspection_certificate", ctx({
    events: [{ id: 9, conditionId: 1, occurredOn: "2026-09-20", amount: 50000,
               plannedAmount: null, expectedAmount: 50000, schedule: null }]
  }), {});
  assert.equal(c.hasChangeLogs, false);
  assert.equal(c.needsSignature, false);
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
    SHOW_SIGN_SECTION: true, SHOW_ORDER_SIGN_SECTION: false,
    calc_method: "ROYALTY", deliverable_ownership: "受注者",
    reward_label: "利用許諾料", rate_pct: 8
  });
});

test("発注書の署名欄は、承諾署名欄だけを出すのが既定（条件が決まらなくても）", () => {
  // 両方の既定が「あり」だと、CSV で欄を空にしたまま作った発注書に
  // 発注者も署名する欄と受注者だけが署名する欄の両方が刷られる。
  assert.deepEqual(suggestionsFor("purchase_order", { conditions: [] }),
    { SHOW_SIGN_SECTION: true, SHOW_ORDER_SIGN_SECTION: false });
  assert.deepEqual(suggestionsFor("intl_purchase_order", { conditions: [] }),
    { SHOW_SIGN_SECTION: true, SHOW_ORDER_SIGN_SECTION: false });
  // 検収書の署名欄は金額が変わったときだけ（計算で決める）ので、ここでは触らない。
  assert.deepEqual(suggestionsFor("inspection_certificate", { conditions: [] }), {});
});

test("条件が複数なら見出しの料率は埋めない（行ごとに違う）", () => {
  assert.deepEqual(suggestionsFor("inspection_certificate", {
    conditions: [{ id: 5, pricingModel: "revenue_rate", ratePct: 8 },
                 { id: 6, pricingModel: "revenue_rate", ratePct: 5 }]
  }), {});
});

test("業績連動の条件は、定額が無くても明細の行にする", () => {
  // 報酬は売上が立ってから決まるが、「何を頼んだか」は発注書に書く。
  // 定額の無い条件を落としていたので、品目名も仕様も無い、金額 ¥0 の行だけが
  // 残る発注書になっていた。
  const lines = orderLinesFrom(ctx({ schedules: [], conditions: [
    { id: 1, name: "品質評価基準の策定および評価分析レポート作成業務",
      notes: "試作品の評価", flatAmount: null, pricingModel: "revenue_rate",
      deliverableOwnership: "contractor", taxCategory: "taxable" }
  ] })) as Array<Record<string, any>>;
  assert.equal(lines.length, 1);
  assert.equal(lines[0].item_name, "品質評価基準の策定および評価分析レポート作成業務");
  assert.equal(lines[0].spec, "試作品の評価");
  assert.equal(lines[0].amount_ex_tax, 0, "金額は売上が立つまで決まらない");
  assert.equal(lines[0].unit_price, 0);
  assert.equal(lines[0].calc_method, "ROYALTY");
  assert.equal(lines[0].reward_label, "利用許諾料", "本文はこちらを出す");
});

test("金額の決まっていない条件も、品目名は紙に出す", () => {
  // 定期課金・単価型・未設定の条件は定額を持たない。落とすと、人が選んだ条件が
  // 紙のどこにも出ないまま、金額 ¥0 の空行だけが残る。
  const lines = orderLinesFrom(ctx({ schedules: [], conditions: [
    { id: 1, name: "品質評価レポート作成業務", flatAmount: null,
      pricingModel: "subscription", taxCategory: "taxable" }
  ] })) as Array<Record<string, any>>;
  assert.equal(lines.length, 1);
  assert.equal(lines[0].item_name, "品質評価レポート作成業務");
  assert.equal(lines[0].amount_ex_tax, 0, "金額はフォームが「未入力」として出す");
  assert.equal(lines[0].calc_method, "SUBSCRIPTION");
});

test("単価建ての条件は 単価 × 個数 を金額にする", () => {
  const lines = orderLinesFrom(ctx({ schedules: [], conditions: [
    { id: 1, name: "自社製造・他社販売", flatAmount: null, unitAmount: 1650, quantity: 100,
      pricingModel: "unit_rate", taxCategory: "taxable" }
  ] })) as Array<Record<string, any>>;
  assert.equal(lines[0].unit_price, 1650);
  assert.equal(lines[0].quantity, 100);
  assert.equal(lines[0].amount_ex_tax, 165000);
});

test("手数料・経費の条件は品目に混ぜず、その他手数料・経費の行の種になる", () => {
  const conditions = [
    { id: 1, name: "翻訳", flatAmount: 100000, pricingModel: "fixed", taxCategory: "taxable", kind: "service" },
    { id: 2, name: "送料", flatAmount: 3000, pricingModel: "fixed", taxCategory: "taxable", kind: "fee" },
    { id: 3, name: "交通費", flatAmount: 12000, pricingModel: "fixed", taxCategory: "exempt", kind: "expense" }
  ];
  const seeds = seedLines("purchase_order", ctx({ schedules: [], conditions }));
  assert.deepEqual(seeds.items.map((r) => r.item_name), ["翻訳"], "品目は委託料だけ");
  assert.deepEqual(seeds.other_fees.map((r) => [r.condition_id, r.fee_name, r.amount]), [[2, "送料", 3000]]);
  assert.deepEqual(seeds.expenses.map((r) => [r.condition_id, r.expense_name, r.amount_inc_tax]), [[3, "交通費", 12000]]);
  // 予定明細があっても、手数料・経費の予定は品目に出さない。
  const withSchedules = orderLinesFrom(ctx({ conditions, schedules: [
    { id: 11, conditionId: 1, seq: 1, label: "納品", plannedAmount: 100000, dueOn: "2026-10-31" },
    { id: 12, conditionId: 2, seq: 1, label: "送料", plannedAmount: 3000, dueOn: "2026-10-31" }
  ] })) as Array<Record<string, any>>;
  assert.equal(withSchedules.length, 1);
  assert.equal(withSchedules[0].amount_ex_tax, 100000);
});

test("実績を選ばず条件を2本（委託料と実費）載せた検収書は、委託料が明細の行、実費は経費の表", () => {
  const conditions = [
    { id: 1, name: "9月 ジャッジ業務", flatAmount: 11818, pricingModel: "fixed", taxCategory: "taxable", kind: "service",
      termEnd: "2026-09-06" },
    { id: 2, name: "交通費", flatAmount: 334, pricingModel: "fixed", taxCategory: "exempt", kind: "expense" }
  ];
  const lines = deliveryLinesFrom(ctx({ events: [], conditions })) as Array<Record<string, any>>;
  assert.equal(lines.length, 1, "以前は条件が1本のときしか行を作らず、単票の枝に落ちていた");
  assert.equal(lines[0].item_name, "9月 ジャッジ業務");
  assert.equal(lines[0].amount_ex_tax, 11818);
  assert.equal(lines[0].delivery_date, "2026-09-06");
  const seeds = seedLines("inspection_certificate", ctx({ events: [], conditions }));
  assert.equal(seeds.delivery_line_items.length, 1);
  assert.deepEqual(seeds.expenses.map((r) => [r.expense_name, r.amount_inc_tax]), [["交通費", 334]]);
  // 行があるので消費税と検収金額も計算される（単票の枝では空だった）。
  const c = buildTemplateContext("inspection_certificate", ctx({ events: [], conditions }),
    { delivery_line_items: seeds.delivery_line_items, expenses: seeds.expenses });
  assert.equal(c.deliveredAmountStr, "11,818");
  assert.equal(c.taxAmountStr, "1,182");
  assert.equal(c.totalAmountStr, "13,000");
  assert.equal(c.grandTotalPayableStr, "13,334", "経費は税込のまま足す");
});

test("委託料が2本なら2行。定額の無い条件は行にしない", () => {
  const lines = deliveryLinesFrom(ctx({ events: [], conditions: [
    { id: 1, name: "第1回", flatAmount: 100000, pricingModel: "fixed", taxCategory: "taxable", kind: "service" },
    { id: 2, name: "第2回", flatAmount: 180000, pricingModel: "fixed", taxCategory: "taxable", kind: "service" },
    { id: 3, name: "未定", flatAmount: null, pricingModel: "none", taxCategory: "taxable", kind: "service" }
  ] })) as Array<Record<string, any>>;
  assert.deepEqual(lines.map((l) => [l.item_name, l.amount_ex_tax]), [["第1回", 100000], ["第2回", 180000]]);
});

test("検収書の行は仕様を「1行のまとめ」と「残りの全文」に分けて持つ（改訂ひな形が読む）", () => {
  const spec = "イベント名：氷星杯　日時：2026/9/13(日) 12:00〜\n●審判業務（判定業務、記録）\n\n●競技イベント遂行業務（進行管理）";
  const [line] = deliveryLinesFrom(ctx({ conditions: [condition({ spec })], condition: condition({ spec }) })) as Array<Record<string, any>>;
  assert.equal(line.spec, spec, "古いひな形が読む spec はそのまま");
  assert.equal(line.spec_head, "イベント名：氷星杯　日時：2026/9/13(日) 12:00〜");
  assert.equal(line.spec_body, "●審判業務（判定業務、記録）\n●競技イベント遂行業務（進行管理）");
  assert.equal(line.has_spec_body, true);
  // 実績を選ばないときの行にも同じ分け方
  const [fromCondition] = deliveryLinesFrom(ctx({ events: [], conditions: [condition({ spec })] })) as Array<Record<string, any>>;
  assert.equal(fromCondition.spec_head, "イベント名：氷星杯　日時：2026/9/13(日) 12:00〜");
  assert.equal(fromCondition.has_spec_body, true);
});

test("仕様が1行なら残りは無し。先頭が箇条書きならまとめにせず全文を下へ。空なら両方空", () => {
  assert.deepEqual(splitSpec("カラーイラスト1点（表紙用）"),
    { spec_head: "カラーイラスト1点（表紙用）", spec_body: "", has_spec_body: false });
  assert.deepEqual(splitSpec("●審判業務\n●遂行業務"),
    { spec_head: "", spec_body: "●審判業務\n●遂行業務", has_spec_body: true });
  assert.deepEqual(splitSpec("  \n"), { spec_head: "", spec_body: "", has_spec_body: false });
  assert.deepEqual(splitSpec("a\r\nb"), { spec_head: "a", spec_body: "b", has_spec_body: true });
});

test("画面で直した明細の仕様からも、まとめと残りを出し直す（種の値を引きずらない）", () => {
  const c = buildTemplateContext("inspection_certificate", ctx(), {
    delivery_line_items: [{ item_name: "翻訳", spec: "納品物：訳文一式\n●英訳\n●校正", spec_head: "古いまとめ",
                            amount_ex_tax: 1000, inspected_amount_ex_tax: 1000, tax_category: "taxable" }]
  }) as Record<string, any>;
  const [line] = c.delivery_line_items;
  assert.equal(line.spec_head, "納品物：訳文一式");
  assert.equal(line.spec_body, "●英訳\n●校正");
  assert.equal(line.has_spec_body, true);
});

test("発注書の経費合計：金額（税込）の欄が空文字で amount にだけ額がある行も足す", () => {
  const c = buildTemplateContext("purchase_order", ctx({ schedules: [] }), {
    expenses: [
      { expense_name: "交通費", amount_inc_tax: "", amount: "502" },
      { expense_name: "交通費", amount_inc_tax: "502" },
      { expense_name: "宿泊費", amount_inc_tax: "¥1,000" }
    ]
  }) as Record<string, any>;
  assert.equal(c.expensesTotalIncTax, 2004);
  assert.equal(c.expensesTotalIncTaxStr, "2,004");
});

// ---------------------------------------------------------------------------
// 納期（A-041）
//
// 納期と契約期間の終了日は別物。業務委託では同じ日になることが多いので
// 気づかれなかったが、許諾の条件では term_end は許諾期間の終わりであって
// 納期ではない。紙の「納期」は条件の納期を先に見る。
// ---------------------------------------------------------------------------

test("発注書の納期は、条件の納期を先に見る", () => {
  const [line] = orderLinesFrom(ctx({ schedules: [], conditions: [
    condition({ deliveryDue: "2026-11-30", termEnd: "2027-03-31" })
  ] }));
  assert.equal(line?.delivery_date, "2026-11-30");
});

test("納期が空なら契約期間の終了日に落ちる（置き場が無かったころの紙）", () => {
  const [line] = orderLinesFrom(ctx({ schedules: [], conditions: [
    condition({ deliveryDue: null, termEnd: "2027-03-31" })
  ] }));
  assert.equal(line?.delivery_date, "2027-03-31");
});

// ---- 発注書：1 ページ目の概要と利用許諾条件（A-048） ------------------------

test("発注書：明細の件数・契約種別・帰属先・支払条件を 1 行にまとめる", () => {
  const c = buildTemplateContext("purchase_order",
    ctx({ conditions: [condition({ paymentTerms: "月末締め翌月末払い", deliverableOwnership: "contractor" })],
          condition: condition({ paymentTerms: "月末締め翌月末払い" }), events: [] }),
    { items: [{ item_name: "表紙", amount_ex_tax: 10000, payment_terms: "請負", deliverable_ownership: "受注者" },
              { item_name: "挿絵", amount_ex_tax: 20000, payment_terms: "請負", deliverable_ownership: "発注者" }],
      other_fees: [{ fee_name: "変換", amount: 500 }],
      expenses: [{ expense_name: "交通費", amount_inc_tax: 1000 }, { expense_name: "書籍", amount_inc_tax: 2000 }] });
  assert.equal(c.items_count, 2);
  assert.equal(c.other_fees_count, 1);
  assert.equal(c.expenses_count, 2);
  assert.equal(c.contract_form_summary, "請負");
  assert.equal(c.ownership_summary, "発注者・受注者（明細参照）");
  assert.equal(c.has_contractor_owned, true);
  assert.equal(c.payment_terms_summary, "月末締め翌月末払い");
  // 受注者帰属なのに許諾条件が無い → 「別途定める」の印。
  assert.equal(c.license_terms_missing, true);
  assert.deepEqual(c.license_terms, []);
});

test("発注書：利用許諾条件は許諾料の扱いで料率・額の欄を出し分ける", () => {
  const c = buildTemplateContext("purchase_order",
    ctx({ events: [],
          licenseTerms: [
            { usageType: "pub_print", pricingModel: "revenue_rate", ratePct: 8, mgAmount: 100000, agAmount: null,
              currency: "JPY", termStart: "2026-10-01", termEnd: "2029-09-30", regions: ["日本"], languages: ["日本語"],
              licenseFeeBasis: "separate", conditionNo: "CL-1", exclusivity: "exclusive" },
            { usageType: "pub_digital", pricingModel: "revenue_rate", ratePct: 0, mgAmount: null, agAmount: null,
              currency: "JPY", termStart: null, termEnd: null, regions: [], languages: [],
              licenseFeeBasis: "included", conditionNo: "CL-2" },
            { usageType: "in_house", pricingModel: "revenue_rate", ratePct: 0, mgAmount: 5, agAmount: null,
              currency: "JPY", termStart: "2026-10-01", termEnd: null, regions: [], languages: ["英語"],
              licenseFeeBasis: "free", conditionNo: "CL-3" }
          ] }),
    { items: [{ item_name: "設定画", amount_ex_tax: 10000, deliverable_ownership: "受注者" }] });
  // 並びは利用形態の定義順（自社製造・自社販売 → 出版（紙） → 出版（電子））。
  const rows = c.license_terms as Array<Record<string, string>>;
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1], { usage: "出版（紙）（独占）", fee: "8 %", guarantee: "MG ¥ 100,000",
                              term: "2026/10/01 〜 2029/09/30", scope: "日本 ／ 日本語", condition_no: "CL-1" });
  assert.equal(rows[2].fee, "利用許諾料は業務委託報酬に含む");
  assert.equal(rows[2].guarantee, "—");
  assert.equal(rows[2].term, "期間の定めなし");
  assert.equal(rows[2].scope, "全世界 ／ 全言語");
  assert.equal(rows[0].fee, "無償");
  assert.equal(rows[0].guarantee, "—", "含む・無償のときは MG/AG を出さない");
  assert.equal(rows[0].term, "2026/10/01 〜 （定めなし）");
  assert.equal(c.license_terms_missing, false);
  assert.equal(c.ownership_summary, "受注者");
});

test("発注書：発注者帰属だけなら許諾条件の印は立たない", () => {
  const c = buildTemplateContext("purchase_order", ctx({ events: [] }),
    { items: [{ item_name: "表紙", amount_ex_tax: 10000, deliverable_ownership: "発注者" }] });
  assert.equal(c.has_contractor_owned, false);
  assert.equal(c.license_terms_missing, false);
  assert.equal(c.ownership_summary, "発注者");
});

test("発注書：納期・支払期日のまとめは日本語の日付にする", () => {
  assert.equal(summarizeDates("2026-10-31"), "2026年10月31日");
  assert.equal(summarizeDates("2026-10-31 〜 2026-11-30 (明細参照)"), "2026年10月31日 〜 2026年11月30日（明細参照）");
  assert.equal(summarizeDates(""), "");
  const c = buildTemplateContext("purchase_order", ctx({ events: [] }),
    { items: [{ item_name: "a", amount_ex_tax: 1, delivery_date: "2026-10-31", payment_date: "2026-12-31" },
              { item_name: "b", amount_ex_tax: 1, delivery_date: "2026-11-30", payment_date: "2026-12-31" }] });
  assert.equal(c.delivery_summary, "2026年10月31日 〜 2026年11月30日（明細参照）");
  assert.equal(c.payment_summary, "2026年12月31日");
});

test("発注書：利用許諾条件の行は利用形態の定義順に並ぶ", () => {
  const c = buildTemplateContext("purchase_order",
    ctx({ events: [], licenseTerms: [
      { id: 3, usageType: "pub_print", pricingModel: "revenue_rate", ratePct: 8, currency: "JPY", licenseFeeBasis: "separate" },
      { id: 1, usageType: "in_house", pricingModel: "revenue_rate", ratePct: 2, currency: "JPY", licenseFeeBasis: "separate" },
      { id: 2, usageType: "sublicense", pricingModel: "revenue_rate", ratePct: 50, currency: "JPY", licenseFeeBasis: "separate" }
    ] }),
    { items: [{ item_name: "x", amount_ex_tax: 1, deliverable_ownership: "受注者" }] });
  assert.deepEqual((c.license_terms as Array<{ usage: string }>).map((r) => r.usage),
    ["自社製造・自社販売", "再許諾", "出版（紙）"]);
});

// ---- 海外版の発注書（英語の値） ----------------------------------------------

test("海外版：日付・帰属先・契約種別・源泉・通貨が英語で出る", () => {
  assert.equal(summarizeDates("2026-10-31", "en"), "October 31, 2026");
  assert.equal(summarizeDates("2026-10-31 – 2026-11-30 (see details)", "en"),
    "October 31, 2026 – November 30, 2026 (see details)");
  const c = buildTemplateContext("intl_purchase_order",
    ctx({ events: [], condition: condition({ currency: "USD", counterparty: { withholding: true } }) }),
    { items: [{ item_name: "a", amount_ex_tax: 10, delivery_date: "2026-10-31", payment_terms: "請負", deliverable_ownership: "受注者" },
              { item_name: "b", amount_ex_tax: 20, delivery_date: "2026-11-30", payment_terms: "請負", deliverable_ownership: "発注者" }] });
  assert.equal(c.delivery_summary, "October 31, 2026 – November 30, 2026 (see details)");
  assert.equal(c.contract_form_summary, "Contract for Work");
  assert.equal(c.ownership_summary, "Purchaser / Contractor (see details)");
  assert.equal(c.withholding_label, "Applicable");
  assert.equal(c.currency_code, "USD");
  assert.equal(c.license_terms_missing, true);
});

test("海外版：利用許諾条件の行は英語（含む＝included、無償＝Royalty-free、通貨コード付き）", () => {
  const c = buildTemplateContext("intl_purchase_order",
    ctx({ events: [], licenseTerms: [
      { usageType: "pub_print", pricingModel: "revenue_rate", ratePct: 8, mgAmount: 100000, currency: "JPY",
        termStart: "2026-10-01", termEnd: "2029-09-30", regions: ["日本"], languages: ["日本語"], licenseFeeBasis: "separate", exclusivity: "exclusive" },
      { usageType: "pub_digital", pricingModel: "revenue_rate", ratePct: 0, currency: "JPY", licenseFeeBasis: "included" },
      { usageType: "in_house", pricingModel: "fixed", flatAmount: 1234.5, currency: "USD", licenseFeeBasis: "separate", termStart: "2026-10-01" }
    ] }),
    { items: [{ item_name: "x", amount_ex_tax: 1, deliverable_ownership: "受注者" }] });
  const rows = c.license_terms as Array<Record<string, string>>;
  assert.equal(rows[0].usage, "In-house manufacture & sale");
  assert.equal(rows[0].fee, "USD 1,234.50");
  assert.equal(rows[0].term, "2026/10/01 – (no end date)");
  assert.equal(rows[0].scope, "Worldwide / All languages");
  assert.equal(rows[1].usage, "Print publishing (exclusive)");
  assert.equal(rows[1].guarantee, "MG JPY 100,000");
  assert.equal(rows[1].scope, "日本 / 日本語");
  assert.equal(rows[2].fee, "License fee included in the service fee");
  assert.equal(rows[2].term, "No fixed term");
});

test("海外版：行の契約種別も英語で刷る（英語で書いてあればそのまま）", () => {
  const c = buildTemplateContext("intl_purchase_order", ctx({ events: [] }),
    { items: [{ item_name: "a", amount_ex_tax: 1, payment_terms: "請負" },
              { item_name: "b", amount_ex_tax: 1, payment_terms: "Service Agreement" }] });
  const items = c.items as Array<Record<string, unknown>>;
  assert.equal(items[0].payment_terms, "Contract for Work");
  assert.equal(items[1].payment_terms, "Service Agreement");
  assert.equal(c.contract_form_summary, "Contract for Work / Service Agreement");
});

test("海外版：種の行の契約種別は英語で入る（編集欄にも英語で出る）", () => {
  const seeds = seedLines("intl_purchase_order",
    ctx({ events: [], conditions: [condition({ contractForm: "請負" })], condition: condition({ contractForm: "請負" }) }));
  assert.equal(seeds.items[0].payment_terms, "Contract for Work");
  const ja = seedLines("purchase_order",
    ctx({ events: [], conditions: [condition({ contractForm: "請負" })], condition: condition({ contractForm: "請負" }) }));
  assert.equal(ja.items[0].payment_terms, "請負");
});

test("海外版：自社の英語表記があれば From（Purchaser）をそれで置き換える。無ければ触らない", () => {
  const company = { name: "株式会社サンプル", address: "東京都", rep: "代表取締役 山田", tel: "03-0000-0000",
                    nameEn: "Sample Inc.", addressEn: "1-2 Kanda, Tokyo, Japan", repEn: "Representative Director: Taro Yamada", telIntl: "+81-3-0000-0000" };
  const c = buildTemplateContext("intl_purchase_order", ctx({ events: [], company }), { items: [{ item_name: "a", amount_ex_tax: 1 }] });
  assert.equal(c.PARTY_A_NAME, "Sample Inc.");
  assert.equal(c.PARTY_A_ADDRESS, "1-2 Kanda, Tokyo, Japan");
  assert.equal(c.PARTY_A_REP, "Representative Director: Taro Yamada");
  assert.equal(c.COMPANY_TEL, "+81-3-0000-0000");
  const bare = buildTemplateContext("intl_purchase_order", ctx({ events: [], company: { name: "株式会社サンプル" } }),
    { items: [{ item_name: "a", amount_ex_tax: 1 }] });
  assert.equal("PARTY_A_NAME" in bare, false, "英語表記が空なら束縛の日本語がそのまま残る");
  const ja = buildTemplateContext("purchase_order", ctx({ events: [], company }), { items: [{ item_name: "a", amount_ex_tax: 1 }] });
  assert.equal("PARTY_A_NAME" in ja, false, "国内版は英語表記を使わない");
});

test("海外版：担当者の英語表記があれば From の担当（部署・氏名）をそれで置き換える", () => {
  const owner = { name: "山田 太郎", department: "海外事業部", nameEn: "Taro Yamada", departmentEn: "Overseas Business Dept." };
  const c = buildTemplateContext("intl_purchase_order", ctx({ events: [], owner }), { items: [{ item_name: "a", amount_ex_tax: 1 }] });
  assert.equal(c.STAFF_NAME, "Taro Yamada");
  assert.equal(c.STAFF_DEPARTMENT, "Overseas Business Dept.");
  const bare = buildTemplateContext("intl_purchase_order", ctx({ events: [], owner: { name: "山田 太郎" } }), { items: [{ item_name: "a", amount_ex_tax: 1 }] });
  assert.equal("STAFF_NAME" in bare, false);
  const ja = buildTemplateContext("purchase_order", ctx({ events: [], owner }), { items: [{ item_name: "a", amount_ex_tax: 1 }] });
  assert.equal("STAFF_NAME" in ja, false);
});

test("海外版：担当者と自社の電話は国際表記（+81）に直して出す。国内版はそのまま", () => {
  const owner = { name: "山田", phone: "03-6811-0730" };
  const company = { name: "株式会社サンプル", tel: "03-0000-0000" };
  const c = buildTemplateContext("intl_purchase_order", ctx({ events: [], owner, company }), { items: [{ item_name: "a", amount_ex_tax: 1 }] });
  assert.equal(c.STAFF_PHONE, "+81-3-6811-0730");
  assert.equal(c.COMPANY_TEL, "+81-3-0000-0000");
  const withIntl = buildTemplateContext("intl_purchase_order",
    ctx({ events: [], owner: { name: "山田", phone: "+1 212 555 0100" }, company: { ...company, telIntl: "+81-3-9999-9999" } }),
    { items: [{ item_name: "a", amount_ex_tax: 1 }] });
  assert.equal(withIntl.STAFF_PHONE, "+1-212-555-0100");
  assert.equal(withIntl.COMPANY_TEL, "+81-3-9999-9999", "国際表記の欄があればそちらが勝つ");
  const ja = buildTemplateContext("purchase_order", ctx({ events: [], owner, company }), { items: [{ item_name: "a", amount_ex_tax: 1 }] });
  assert.equal("STAFF_PHONE" in ja, false);
});
