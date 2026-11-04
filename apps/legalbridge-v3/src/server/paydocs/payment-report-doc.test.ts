import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildPaymentReport, buildReportDoc, includeDoc, moneyText, parseMoneyText, templateValues,
  type RawDoc, type RawPayment
} from "./payment-report-doc.js";
import { PAYMENT_REPORT_TEMPLATE_HTML } from "./payment-report-template.js";
import { renderDocumentHtml } from "../documents/render.js";

const party = { id: 7, name: "如月 涼", kind: "individual" as const, address: "東京都千代田区1-1", invoiceNo: null };

const raw = (over: Partial<RawDoc> = {}): RawDoc => ({
  id: 1, documentNo: "ARC-INS-2026-0001", templateKey: "inspection_certificate", templateLabel: "検収書",
  title: "イラスト制作", issuedOn: "2026-09-30", printedPayOn: "2026-10-31",
  rendered: {}, statements: [], statementLines: [], events: [], payments: [], ...over
});
const pay = (over: Partial<RawPayment> = {}): RawPayment => ({
  id: 10, paymentNo: "PAY-2026-0010", currency: "JPY", amount: 100000, taxAmount: 10000, withholdingAmount: 10210,
  dueOn: "2026-10-31", paidOn: null, status: "planned", allocated: 100000, allocatedTotal: 100000, ...over
});

test("金額の文字列：円・外貨・紙の文字列の読み取り", () => {
  assert.equal(moneyText(330000), "¥330,000");
  assert.equal(moneyText(1234, "USD"), "USD 12.34");
  assert.equal(parseMoneyText("¥330,000"), 330000);
  assert.equal(parseMoneyText("330,000円"), 330000);
  assert.equal(parseMoneyText("△1,000"), -1000);
  assert.equal(parseMoneyText(""), null);
});

test("検収書：紙に刷った明細の行を出し、支払が無ければ紙の合計と支払予定日を使う", () => {
  const d = buildReportDoc(raw({
    rendered: {
      deliveryLines: [
        { item_name: "表紙イラスト", spec_head: "カラー1点", order_no: "ARC-PO-2026-0003",
          quantity: 1, unit_price: 100000, amount_ex_tax: 100000, delivery_date: "2026-09-20", payment_date: "2026-10-31" },
        { item_name: "挿絵", inspected_quantity: 5, unit_price: 20000, inspected_amount_ex_tax: 100000,
          term_start: "2026-09-01", term_end: "2026-09-30" }
      ],
      expenses: [{ expense_name: "交通費", amount_inc_tax: 3300, spent_date: "2026-09-10" }],
      subtotal: "200,000", tax: "20,000", grand: "223,300"
    }
  }));
  assert.equal(d.kind, "inspection");
  assert.equal(d.lines.length, 3);
  assert.equal(d.lines[0].dateText, "2026/09/20");
  assert.equal(d.lines[0].detail, "カラー1点　発注番号 ARC-PO-2026-0003");
  // 行の支払日は 1 つだけなので、行には出さない（文書の支払日に出る）。
  assert.equal(d.lines[0].payOn, null);
  assert.equal(d.lines[1].dateText, "2026/09/01〜2026/09/30");
  assert.equal(d.lines[1].quantityStr, "5");
  assert.equal(d.lines[2].name, "交通費（実費・税込）");
  // 実費（税込）は小計の外。紙のお支払額から戻す。
  assert.equal(d.amount, 203300);
  assert.equal(d.tax, 20000);
  assert.equal(d.net, 223300);
  assert.equal(d.amountSource, "document");
  assert.equal(d.payOn, "2026-10-31");
  assert.equal(d.payStatus, "unregistered");
});

test("分納で行ごとに支払予定日が違えば、行に支払日を出す（支払の記録が無いときだけ）", () => {
  const lines = [
    { item_name: "前金", amount_ex_tax: 50000, payment_date: "2026-10-31" },
    { item_name: "後金", amount_ex_tax: 50000, payment_date: "2026-11-30" }
  ];
  const d = buildReportDoc(raw({ rendered: { deliveryLines: lines } }));
  assert.deepEqual(d.lines.map((l) => l.payOn), ["2026-10-31", "2026-11-30"]);
  const paid = buildReportDoc(raw({ rendered: { deliveryLines: lines }, payments: [pay()] }));
  assert.deepEqual(paid.lines.map((l) => l.payOn), [null, null]);
});

test("支払があれば支払の額と日付。支払済みは支払日、按分は割当の割合", () => {
  const d = buildReportDoc(raw({
    payments: [pay({ status: "paid", paidOn: "2026-10-30" })]
  }));
  assert.equal(d.amountSource, "payment");
  assert.equal(d.payOn, "2026-10-30");
  assert.equal(d.payStatus, "paid");
  assert.equal(d.withholding, 10210);
  assert.equal(d.net, 100000 + 10000 - 10210);
  assert.equal(d.hasWithholding, true);

  const half = buildReportDoc(raw({ payments: [pay({ allocated: 50000, allocatedTotal: 100000, withholdingAmount: 0 })] }));
  assert.equal(half.amount, 50000);
  assert.equal(half.tax, 5000);
  assert.equal(half.payStatus, "planned");
});

test("計算書：計算書の明細（料率・単価）を出す", () => {
  const d = buildReportDoc(raw({
    id: 2, documentNo: "ARC-RS-2026-0002", templateKey: "royalty_statement", templateLabel: "利用許諾料計算書",
    statements: [{ id: 5, period: "2026年上期", currency: "JPY", netAmount: 48000, taxAmount: 4800 }],
    statementLines: [
      { statementId: 5, period: "2026年上期", productName: "紙書籍 初版", quantity: 3000, sampleQuantity: 0,
        unitAmount: 1600, ratePpm: 100000, salesInput: 480000, amount: 48000, conditionName: "紙書籍 印税", conditionNo: "CL-1" }
    ]
  }));
  assert.equal(d.kind, "statement");
  assert.equal(d.kindLabel, "利用許諾料計算書");
  assert.equal(d.lines[0].unitStr, "10%");
  assert.equal(d.lines[0].quantityStr, "3,000");
  assert.equal(d.lines[0].dateText, "2026年上期");
  assert.equal(d.amount, 48000);
  assert.equal(d.tax, 4800);
  assert.equal(d.period, "2026年上期");
});

test("期間の基準：支払日（予定含む）／支払済みのみ／発行日", () => {
  const planned = buildReportDoc(raw({ payments: [pay()] }));
  assert.equal(includeDoc(planned, "pay", "2026-10-01", "2026-10-31"), true);
  assert.equal(includeDoc(planned, "paid", "2026-10-01", "2026-10-31"), false);
  assert.equal(includeDoc(planned, "issued", "2026-10-01", "2026-10-31"), false);
  assert.equal(includeDoc(planned, "issued", "2026-09-01", "2026-09-30"), true);
});

test("報告書：支払日順に並べ、支払日ごとにまとめ、通貨ごとに合計する。除外した文書は載せない", () => {
  const docs = [
    raw({ id: 1, documentNo: "B", payments: [pay({ id: 11, dueOn: "2026-10-31", withholdingAmount: 0 })] }),
    raw({ id: 2, documentNo: "A", payments: [pay({ id: 12, dueOn: "2026-10-15", withholdingAmount: 0 })] }),
    raw({ id: 3, documentNo: "C", payments: [pay({ id: 13, dueOn: "2026-10-31", withholdingAmount: 0 })] }),
    raw({ id: 4, documentNo: "D", payments: [pay({ id: 14, dueOn: "2026-11-30" })] }),
    raw({ id: 5, documentNo: "E", payments: [pay({ id: 15, dueOn: "2026-10-20" })] })
  ];
  const r = buildPaymentReport({ party, from: "2026-10-01", to: "2026-10-31", basis: "pay", docs, excludeIds: [5] });
  assert.deepEqual(r.documents.map((d) => d.documentNo), ["A", "B", "C"]);
  assert.deepEqual(r.documents.map((d) => d.index), [1, 2, 3]);
  assert.equal(r.skipped, 2);
  assert.deepEqual(r.payDates.map((p) => [p.date, p.docs.length, p.multiple]), [["2026-10-15", 1, false], ["2026-10-31", 2, true]]);
  assert.equal(r.payDates[1].netStr, "¥220,000");
  assert.equal(r.totals.length, 1);
  assert.equal(r.totals[0].net, 330000);
  assert.equal(r.totals[0].count, 3);
});

test("ひな形：templates/ の本文と既定の本文が同じ", () => {
  const file = readFileSync(new URL("../../../../../infra/v3/templates/payment_report.html", import.meta.url), "utf8").trimEnd();
  assert.equal(PAYMENT_REPORT_TEMPLATE_HTML, file);
});

test("ひな形を描くと、支払日・文書番号・明細・合計が紙に出る", () => {
  const docs = [
    raw({
      id: 1, documentNo: "ARC-INS-2026-0001",
      rendered: { deliveryLines: [{ item_name: "表紙イラスト", quantity: 1, unit_price: 100000, amount_ex_tax: 100000, delivery_date: "2026-09-20" }] },
      payments: [pay({ status: "paid", paidOn: "2026-10-30" })]
    }),
    raw({
      id: 2, documentNo: "ARC-RS-2026-0002", templateKey: "royalty_statement", templateLabel: "利用許諾料計算書",
      title: "星降る街の図書館", printedPayOn: "2026-10-31",
      statements: [{ id: 5, period: "2026年上期", currency: "JPY", netAmount: 48000, taxAmount: 4800 }],
      statementLines: [{ statementId: 5, period: "2026年上期", productName: "紙書籍 初版", quantity: 3000, sampleQuantity: null,
                         unitAmount: null, ratePpm: 100000, salesInput: 480000, amount: 48000, conditionName: null, conditionNo: null }]
    })
  ];
  const report = buildPaymentReport({ party, from: "2026-10-01", to: "2026-10-31", basis: "pay", docs });
  const html = renderDocumentHtml(PAYMENT_REPORT_TEMPLATE_HTML, templateValues(report, {
    company: { name: "株式会社サンプル", address: "東京都千代田区2-2", invoiceNo: "T1234567890123" },
    documentDate: "2026-11-04", remarks: "10月分のご報告です。"
  }));
  assert.match(html, /支払報告書/);
  assert.match(html, /如月 涼　様/);
  assert.match(html, /お支払先/);
  assert.match(html, /ARC-INS-2026-0001/);
  assert.match(html, /ARC-RS-2026-0002/);
  assert.match(html, /2026年10月30日/);
  assert.match(html, /2026年10月31日/);
  assert.match(html, /表紙イラスト/);
  assert.match(html, /紙書籍 初版/);
  assert.match(html, /10%/);
  assert.match(html, /源泉徴収/);
  assert.match(html, /10月分のご報告です。/);
  // 合計：検収書 100,000 + 10,000 − 10,210 ＋ 計算書 48,000 + 4,800
  assert.match(html, /¥152,590/);
  assert.match(html, /検収書 1 件・利用許諾料計算書 1 件/);
  assert.doesNotMatch(html, /\{\{|\}\}/);
});
