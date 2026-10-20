import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderDocumentHtml } from "./render.js";
import { buildTemplateContext, deliveryLinesFrom, lineFieldsFor } from "./template-context.js";
import { settlementDocFor, settlesEvents, SERVICE_COMPLETION_KEY } from "./settlement-docs.js";

/**
 * 役務提供完了通知書（A-073）。本文は infra/v3/templates/service_completion_notice.html。
 * 準委任で時間精算（月間包括枠＋実績時間）の委託料の決済文書。
 */
const html = readFileSync(new URL("../../../../../infra/v3/templates/service_completion_notice.html", import.meta.url), "utf8");

const condition = (over: Record<string, any> = {}) => ({
  id: 1, name: "法務支援業務", kind: "service", taxCategory: "taxable", currency: "JPY",
  pricingModel: "subscription", flatAmount: 200000, contractForm: "準委任",
  termStart: "2026-11-01", termEnd: "2027-01-31",
  timeSettlement: true, hoursIncluded: 64, overageUnitAmount: 3125, shortfallUnitAmount: null,
  spec: "法務支援業務（月間包括委託枠）",
  counterparty: { name: "阿部山 孝光", kind: "individual", invoiceNo: null },
  ...over
});
const event = (over: Record<string, any> = {}) => ({
  id: 9, conditionId: 1, occurredOn: "2026-11-30", amount: 225000, plannedAmount: 200000,
  hours: 72, reportReceivedOn: "2026-12-02", serviceFrom: "2026-11-01", serviceTo: "2026-11-30",
  triggerKind: "periodic", schedule: { payOn: "2026-12-21", dueOn: "2026-11-30" },
  ...over
});
const ctx = (over: Record<string, any> = {}) => ({
  document: { number: "ARC-SC-2026-0001", issuedOn: "2026-12-04" },
  conditions: [condition()], condition: condition(),
  events: [event()], schedules: [], bank: null,
  ...over
});

test("時間精算の回は 包括枠／超過 の行に分かれ、合計は 基本＋超過", () => {
  const lines = deliveryLinesFrom(ctx());
  assert.equal(lines.length, 2);
  assert.equal(lines[0].sc_role, "base");
  assert.equal(lines[0].inspected_amount_ex_tax, 200000);
  assert.equal(lines[0].sc_hours_text, "64 h");
  assert.equal(lines[1].sc_role, "overage");
  assert.equal(lines[1].inspected_amount_ex_tax, 25000);
  assert.equal(lines[1].sc_hours_text, "8 h");
  // 超過の行は予定額を持たない（変更履歴にしない）。基本の行は予定どおり。
  assert.equal(lines[1].ordered_amount_ex_tax, null);
  assert.equal(lines[0].ordered_amount_ex_tax, 200000);

  const c = buildTemplateContext(SERVICE_COMPLETION_KEY, ctx(), {});
  assert.equal(c.taxableSubtotalExTaxStr, "225,000");
  assert.equal(c.combinedTaxStr, "22,500");
  assert.equal(c.grandTotalPayableStr, "247,500");
  assert.equal(c.hasChangeLogs, false, "超過は変更履歴ではない");
  assert.equal(c.needsSignature, true, "超過があれば署名欄");
  assert.equal(c.hasOverage, true);
  assert.equal(c.sc_month_label, "2026年11月分");
  assert.equal(c.sc_report_received_on, "2026-12-02");
  assert.equal(c.sc_confirm_deadline, "2026-12-18", "発行日 12/4 から 10 営業日");
  assert.equal(c.sc_is_invoice_statement, false);
  assert.equal(c.sc_payment_date, "2026-12-21", "回の支払期日");
  const noPayOn = buildTemplateContext(SERVICE_COMPLETION_KEY, ctx({ events: [event({ schedule: null })] }), {});
  assert.equal(noPayOn.sc_payment_date, "2026-12-20", "回に支払期日が無ければ 完了日の翌月 20 日（個人）");
});

test("枠どおりの月は 1 行で署名欄なし。未消化は控除単価があるときだけ控除の行", () => {
  const flat = buildTemplateContext(SERVICE_COMPLETION_KEY, ctx({ events: [event({ hours: 60, amount: 200000 })] }), {});
  assert.equal((flat.delivery_line_items as unknown[]).length, 1);
  assert.equal(flat.needsSignature, false);
  assert.equal(flat.grandTotalPayableStr, "220,000");

  const deduct = buildTemplateContext(SERVICE_COMPLETION_KEY,
    ctx({ conditions: [condition({ shortfallUnitAmount: 3000 })], condition: condition({ shortfallUnitAmount: 3000 }),
          events: [event({ hours: 60, amount: 188000 })] }), {});
  const lines = deduct.delivery_line_items as Array<Record<string, unknown>>;
  assert.equal(lines.length, 2);
  assert.equal(lines[1].sc_role, "shortfall");
  assert.equal(lines[1].inspected_amount_ex_tax, -12000);
  assert.equal(deduct.grandTotalPayableStr, "206,800");
  assert.equal(deduct.hasShortfall, true);
  assert.equal(deduct.needsSignature, true);
});

test("実績のメモ（案件別の実績）は包括枠の行の下に出る。実費の条件の実績は明細の行にしない", () => {
  const note = "LGL-003 契約スキーム相談 18 h\nLGL-004 契約書レビュー 31.5 h";
  const expense = { id: 2, kind: "expense", name: "交通費", taxCategory: "exempt", currency: "JPY", flatAmount: 1840 };
  const c = buildTemplateContext(SERVICE_COMPLETION_KEY,
    ctx({ conditions: [condition(), expense], events: [event({ note }), { id: 10, conditionId: 2, occurredOn: "2026-11-26", amount: 1840 }] }), {});
  const lines = c.delivery_line_items as Array<Record<string, unknown>>;
  assert.equal(lines.length, 2, "実費の実績は行にならない");
  assert.equal(lines[0].spec_body, note);
  assert.equal(lines[0].has_spec_body, true);
  assert.equal(c.taxableSubtotalExTaxStr, "225,000");
  assert.equal(c.expensesTotalIncTaxStr, "1,840");
  assert.equal(c.grandTotalPayableStr, "249,340");
});

test("時間精算でない条件・実績時間の無い回は従来の 1 行のまま", () => {
  const plain = deliveryLinesFrom(ctx({ conditions: [condition({ timeSettlement: false })], condition: condition({ timeSettlement: false }) }));
  assert.equal(plain.length, 1);
  assert.equal(plain[0].sc_role, undefined);
  const noHours = deliveryLinesFrom(ctx({ events: [event({ hours: null })] }));
  assert.equal(noHours.length, 1);
});

test("本文：副題・業務概要・明細・合計・署名欄・確認期限が出る", () => {
  const computed = buildTemplateContext(SERVICE_COMPLETION_KEY, ctx(), {});
  const out = renderDocumentHtml(html, {
    ...computed, VENDOR_NAME: "阿部山 孝光", VENDOR_SUFFIX: "様", PARTY_A_NAME: "株式会社アークライト",
    PROJECT_TITLE: "法務支援業務", parent_po_number: "ARC-PO-2026-1134", PAYMENT_DATE: "2026-12-21",
    STAFF_NAME: "倉持 達也", STAFF_DEPARTMENT: "法務部", inspectorName: "倉持 達也", inspectorDept: "法務部"
  });
  assert.match(out, /役務提供完了通知書/);
  assert.doesNotMatch(out, /兼 仕入明細書/, "登録番号なしなら副題を出さない");
  assert.match(out, /2026年11月分の役務の提供が完了/);
  assert.match(out, /月間包括枠 64 h　200,000 円／月/);
  assert.match(out, /超過分 3,125 円／h/);
  assert.match(out, /2026年12月2日 受領/);
  assert.match(out, /月間包括枠 超過分の追加委託料/);
  assert.match(out, /実績 72 h − 包括枠 64 h/);
  assert.match(out, /源泉徴収税計算前お支払額<\/th><td>247,500/);
  assert.match(out, /2026年12月21日/);
  assert.match(out, /<div class="page-break annex">/, "変更があれば 2 ページ目に内容変更確認書");
  assert.match(out, /内容変更確認書/);
  assert.match(out, /超過 8 h × 3,125 円 ＝ 25,000 円を追加精算/);
  assert.match(out, /10 営業日以内（2026年12月18日まで）/);
  assert.match(out, /源泉徴収 対象外/);
  assert.match(out, /登録番号: 未登録/);
});

test("本文：登録番号ありなら「兼 仕入明細書」、枠どおりなら署名欄なし", () => {
  const c = condition({ counterparty: { name: "合同会社アトリエ蒼", kind: "corporate", invoiceNo: "T9010001000001" } });
  const computed = buildTemplateContext(SERVICE_COMPLETION_KEY,
    ctx({ conditions: [c], condition: c, events: [event({ hours: 64, amount: 200000 })] }), {});
  const out = renderDocumentHtml(html, { ...computed, VENDOR_NAME: "合同会社アトリエ蒼", INVOICE_REGISTRATION_NUMBER: "T9010001000001" });
  assert.match(out, /兼 仕入明細書/);
  assert.match(out, /登録番号: T9010001000001/);
  assert.doesNotMatch(out, /<div class="page-break annex">/, "枠どおりなら 2 ページ目は無い");
});

test("決済文書の振り分け：時間精算の委託料だけ役務提供完了通知書", () => {
  assert.equal(settlementDocFor({ kind: "service", timeSettlement: true }).templateKey, SERVICE_COMPLETION_KEY);
  assert.equal(settlementDocFor({ kind: "service", timeSettlement: false }).templateKey, "inspection_certificate");
  assert.equal(settlementDocFor("service").templateKey, "inspection_certificate");
  assert.equal(settlementDocFor({ kind: "license", timeSettlement: true }).templateKey, "royalty_statement");
  assert.equal(settlesEvents(SERVICE_COMPLETION_KEY), true);
  assert.deepEqual(lineFieldsFor(SERVICE_COMPLETION_KEY), ["delivery_line_items", "other_fees", "expenses"]);
});
