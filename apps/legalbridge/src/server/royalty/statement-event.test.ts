import assert from "node:assert/strict";
import test from "node:test";
import { royaltyEventInputFromStatement } from "./statement-event.js";
import { calculateFee } from "../../royalty/calc.js";

// 計算書 → 消化イベント自動記帳の入力組み立て（純関数）。
// PDF・プレビューの buildSingleStatementPatch と同じ terms/adjustments になること。

const EVENT_FORM = {
  rsConditionLineId: 42, statementMode: "single",
  rsCalcType: "event", rsMsrp: 1000, rsQuantity: 500, rsSampleQuantity: 20,
  rsRatePct: 5, rsMgAmount: 100000, rsAgAmount: 200000, rsAgConsumedBefore: 50000,
  taxRate: 10
};

test("イベント式: performance terms＋AG調整で組み立てる", () => {
  const input = royaltyEventInputFromStatement(EVENT_FORM)!;
  assert.equal(input.conditionLineId, 42);
  assert.deepEqual(input.terms, { type: "performance", base_price: 1000, rate_pct: 5, quantity: 500 });
  assert.deepEqual(input.adjustments, {
    sample_quantity: 20, mg_amount: 100000, ag_amount: 200000, ag_consumed_before: 50000
  });
  // 記帳額はサーバ再計算（gross=ceil((500-20)*1000*5%)=24000 → MG floor 100000 → AG充当）
  const fee = calculateFee(input.terms, input.adjustments, input.taxRatePct);
  assert.equal(fee.actual_ex_tax, 0);                   // MG 100000 が全額 AG 充当（残150000内）
  assert.equal(fee.ag_offset_this_time, 100000);
});

test("時限式: revenue terms・periodは算定期間Toから YYYY-MM", () => {
  const input = royaltyEventInputFromStatement({
    rsConditionLineId: 7, rsCalcType: "period", rsBasisKind: "sales",
    rsMsrp: 2000000, rsRatePct: 8, rsPeriodFrom: "2026-04-01", rsPeriodTo: "2026-06-30"
  })!;
  assert.deepEqual(input.terms, { type: "revenue", base_amount: 2000000, rate_pct: 8 });
  assert.equal(input.period, "2026-06");
  assert.equal(input.adjustments.sample_quantity, 0);
  assert.equal(input.taxRatePct, 10);                   // 既定
});

test("対象外: ひも付け無し・多明細・実績未入力は null", () => {
  assert.equal(royaltyEventInputFromStatement({ rsCalcType: "event", rsMsrp: 100 }), null);
  assert.equal(royaltyEventInputFromStatement({ ...EVENT_FORM, statementMode: "multi" }), null);
  assert.equal(royaltyEventInputFromStatement({ rsConditionLineId: 42 }), null);
  assert.equal(royaltyEventInputFromStatement({ rsConditionLineId: 42, rsCalcType: "event", rsMsrp: 0 }), null);
});
