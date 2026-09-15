import test from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "../core/errors.js";
import { basisAmountOf, basisNoteOf, bundleLineFrom, bundleTotals, methodLabelOf } from "./bundle.js";
import type { CalculationPreview } from "./statement-service.js";

/** 試算の結果。必要な欄だけ埋める。 */
function preview(over: Record<string, any> = {}): CalculationPreview {
  const condition = {
    id: 5, conditionNo: "CL-2026-00042", currency: "JPY", pricingModel: "revenue_rate",
    name: "配信許諾（自社販売）", kind: "license", direction: "out", counterpartyId: 11,
    agreementTitle: "配信許諾基本契約", agreementNo: "AG-2026-0001",
    ratePct: 12.5, unitAmount: 0, mgAmount: 0, agAmount: 0, taxRatePct: 10,
    ...(over.condition ?? {})
  };
  const fee = {
    gross_ex_tax: 612000, after_acceptance: 612000,
    mg_topup_this_time: 0, mg_floor_applied: false,
    mg_consumed_this_time: 0, mg_remaining_after: 0, mg_fully_consumed: false,
    ag_offset_this_time: 0, ag_remaining_after: 0, ag_fully_consumed: false,
    actual_ex_tax: 612000, tax_rate: 10, tax_amount: 61200, total_inc_tax: 673200,
    formula_breakdown: "", ...(over.fee ?? {})
  };
  return {
    condition, fee,
    payment: { subtotalExTax: fee.actual_ex_tax, taxAmount: fee.tax_amount,
               totalIncTax: fee.total_inc_tax, withholdingTax: 0,
               netTransfer: fee.total_inc_tax, withholdingEnabled: false,
               ...(over.payment ?? {}) } as any,
    amounts: { grossMinor: fee.gross_ex_tax, netMinor: fee.actual_ex_tax,
               taxMinor: fee.tax_amount, agOffsetMinor: 0, mgTopupMinor: 0,
               ...(over.amounts ?? {}) },
    agConsumedBefore: 0, appliedVersion: null,
    reported: over.reported ?? { salesInput: 4896000 },
    period: over.period ?? "2026上期", occurredOn: null,
    events: over.events ?? []
  } as CalculationPreview;
}

test("束ねの行：契約名・契約番号・条件名が出る", () => {
  const line = bundleLineFrom(preview());
  assert.equal(line.conditionId, 5);
  assert.equal(line.contractTitle, "配信許諾基本契約");
  assert.equal(line.contractNumber, "AG-2026-0001");
  assert.equal(line.conditionName, "配信許諾（自社販売）");
  assert.equal(line.paymentJpy, 612000);
  assert.equal(line.ratePct, 12.5);
});

test("束ねの行：契約が無ければ条件番号を番号欄に置く", () => {
  // 何の分の行かが読めない紙は出さない。
  const line = bundleLineFrom(preview({ condition: { agreementTitle: null, agreementNo: null } }));
  assert.equal(line.contractNumber, "CL-2026-00042");
});

test("根拠額：料率は報告売上、数量ベースは有償数量×基準価格", () => {
  assert.equal(basisAmountOf(preview()), 4896000);
  assert.equal(
    basisAmountOf(preview({
      condition: { pricingModel: "unit_rate", unitAmount: 1200 },
      reported: { quantity: 500, sampleQuantity: 20 }
    })), 480 * 1200);
});

test("根拠額：料率でも数量ベースでもなければ総額を置く", () => {
  assert.equal(basisAmountOf(preview({ condition: { pricingModel: "fixed" } })), 612000);
});

test("計算の見出しは実績の種類で決まる", () => {
  assert.equal(methodLabelOf(preview()), "売上報告ベース");
  assert.equal(methodLabelOf(preview({ events: [{ eventType: "sublicense_receipt" }] })),
               "サブライセンス受領ベース");
  assert.equal(methodLabelOf(preview({ condition: { pricingModel: "unit_rate" } })), "製造数量ベース");
});

test("但し書きに算定期間・MG・AG が出る", () => {
  const note = basisNoteOf(preview({
    fee: { mg_floor_applied: true, mg_topup_this_time: 50000, ag_offset_this_time: 30000 },
    events: [{ eventType: "sales" }, { eventType: "sales" }]
  }));
  assert.match(note, /算定期間 2026上期/);
  assert.match(note, /MG適用 \+50,000/);
  assert.match(note, /AG充当 −30,000/);
  assert.match(note, /実績 2 件/);
});

test("合計：消費税は条件ごとの税額を足す（税区分が違いうる）", () => {
  const totals = bundleTotals([
    preview(),
    preview({
      condition: { id: 9, taxRatePct: 8 },
      fee: { actual_ex_tax: 100000, tax_amount: 8000, total_inc_tax: 108000 },
      amounts: { netMinor: 100000 }, reported: { salesInput: 800000 }
    })
  ]);
  assert.equal(totals.netExTax, 712000);
  assert.equal(totals.tax, 69200, "10% と 8% を総額に一律で掛けない");
  assert.equal(totals.basis, 5696000);
  assert.equal(totals.netMinor, 712000);
});

test("通貨や相手先の違う条件は1枚にまとめない", () => {
  assert.throws(
    () => bundleTotals([preview(), preview({ condition: { id: 9, currency: "USD" } })]),
    (e: unknown) => e instanceof DomainError && /通貨の違う条件/.test(e.message));
  assert.throws(
    () => bundleTotals([preview(), preview({ condition: { id: 9, counterpartyId: 22 } })]),
    (e: unknown) => e instanceof DomainError && /相手先の違う条件/.test(e.message));
});

test("1件も無ければ断る", () => {
  assert.throws(() => bundleTotals([]), (e: unknown) => e instanceof DomainError);
});
