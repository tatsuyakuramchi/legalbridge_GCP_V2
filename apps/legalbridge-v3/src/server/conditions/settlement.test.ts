import test from "node:test";
import assert from "node:assert/strict";
import { isSettled, settlementOf, settlementState, targetAmountOf } from "./settlement.js";

const fixed = { pricingModel: "fixed", flatAmount: 100000, eventCount: 0, plannedAmount: 0, paidAmount: 0 };

test("定額の条件は 未着手 → 検収済み → 支払予定 → 一部 → 支払済み と進む", () => {
  assert.equal(settlementState(fixed), "open");
  assert.equal(settlementState({ ...fixed, eventCount: 1 }), "inspected");
  assert.equal(settlementState({ ...fixed, eventCount: 1, plannedAmount: 100000 }), "payment_planned");
  assert.equal(settlementState({ ...fixed, eventCount: 2, paidAmount: 60000, plannedAmount: 40000 }), "partly_paid");
  assert.equal(settlementState({ ...fixed, eventCount: 2, paidAmount: 100000 }), "paid");
  assert.equal(settlementState({ ...fixed, paidAmount: 120000 }), "paid", "払い過ぎでも支払済み");
  assert.equal(isSettled("paid"), true);
  assert.equal(isSettled("partly_paid"), false);
});

test("人が閉じれば何より先に完了扱い。単価×数量は定額に畳んであれば定額と同じ", () => {
  assert.equal(settlementState({ ...fixed, closedAt: "2026-09-15T00:00:00Z" }), "closed");
  assert.equal(isSettled("closed"), true);
  assert.equal(targetAmountOf({ pricingModel: "unit_rate", flatAmount: 120000 }), 120000);
  assert.equal(targetAmountOf({ pricingModel: "revenue_rate", flatAmount: 120000 }), null, "料率は払い切る額を持たない");
  assert.equal(targetAmountOf({ pricingModel: "fixed", flatAmount: 0 }), null);
});

test("料率の条件は終わりが無い。動けば進行中、期間が過ぎれば期間終了", () => {
  const rate = { pricingModel: "revenue_rate", flatAmount: null, eventCount: 0, plannedAmount: 0, paidAmount: 0 };
  assert.equal(settlementState(rate, "2026-09-15"), "open");
  assert.equal(settlementState({ ...rate, eventCount: 3 }, "2026-09-15"), "in_progress");
  assert.equal(settlementState({ ...rate, paidAmount: 5000 }, "2026-09-15"), "in_progress");
  assert.equal(settlementState({ ...rate, termEnd: "2026-03-31" }, "2026-09-15"), "expired");
  assert.equal(settlementState({ ...rate, termEnd: "2026-03-31", eventCount: 1 }, "2026-09-15"), "in_progress");
});

test("行から組む：pg の bigint 文字列・Date を受ける", () => {
  const s = settlementOf({
    pricing_model: "fixed", flat_amount: "100000", term_end: new Date("2026-12-31T00:00:00Z"),
    event_count: 2, delivered_amount: "100000", planned_amount: "0", paid_amount: "100000",
    closed_at: null, closed_reason: null
  });
  assert.equal(s.state, "paid");
  assert.equal(s.done, true);
  assert.equal(s.targetAmount, 100000);
  assert.equal(s.paidAmount, 100000);
  const closed = settlementOf({ pricing_model: "fixed", flat_amount: 5000, event_count: 0, delivered_amount: 0,
    planned_amount: 0, paid_amount: 0, closed_at: new Date("2026-09-01T00:00:00Z"), closed_reason: "V2 で支払済み" });
  assert.equal(closed.state, "closed");
  assert.equal(closed.closedReason, "V2 で支払済み");
  assert.equal(closed.closedAt, "2026-09-01T00:00:00.000Z");
});
