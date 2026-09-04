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

test("束ね: 条件明細ひも付けのある契約ごとに記帳入力を作る（ひも付け無し・基準額無しは除く）", async () => {
  const { royaltyEventInputsFromStatement } = await import("./statement-event.js");
  const inputs = royaltyEventInputsFromStatement({
    statementMode: "bundle", taxRate: 10,
    rs_bundle: [
      { conditionLineId: 501, calcType: "period", basisKind: "sales", msrp: 1000000, ratePct: 3, mgAmount: 50000, periodTo: "2026-06-30" },
      { conditionLineId: 620, calcType: "event", msrp: 6000, quantity: 3000, sampleQuantity: 100, ratePct: 5, agAmount: 300000, agConsumedBefore: 180000 },
      { conditionLineId: "", calcType: "period", msrp: 500000, ratePct: 5 },
      { conditionLineId: 700, calcType: "period", msrp: 0, ratePct: 5 }
    ]
  });
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0].conditionLineId, 501);
  assert.deepEqual(inputs[0].terms, { type: "revenue", base_amount: 1000000, rate_pct: 3 });
  assert.equal(inputs[0].period, "2026-06");
  assert.deepEqual(inputs[1].terms, { type: "performance", base_price: 6000, rate_pct: 5, quantity: 3000 });
  assert.equal(inputs[1].adjustments.sample_quantity, 100);
  assert.equal(inputs[1].adjustments.ag_consumed_before, 180000);
  // 単票は従来どおり 0〜1 件、多明細（受領行なし）は 0 件
  assert.equal(royaltyEventInputsFromStatement(EVENT_FORM).length, 1);
  assert.equal(royaltyEventInputsFromStatement({ ...EVENT_FORM, statementMode: "multi" }).length, 0);
  assert.equal(royaltyEventInputFromStatement({ ...EVENT_FORM, statementMode: "bundle" }), null);
});

test("多明細（かんたん受領入力）: 受領行の円換算 base 合計 × イン側料率をイン条件へ記帳する（MG/AG は掛けない）", async () => {
  const { royaltyEventInputsFromStatement } = await import("./statement-event.js");
  const inputs = royaltyEventInputsFromStatement({
    statementMode: "multi", rsConditionLineId: 501, rsInRatePct: 5, rsMgAmount: 100000, taxRate: 10,
    rs_receipts: [
      { sublicensee: "Meridian Games", currency: "USD", amount: 12000, fxMode: "pre", fxRate: 148.2, receivedOn: "2026-05-10" },
      { sublicensee: "Seoul Tabletop", currency: "JPY", amount: 890000, fxMode: "post", receivedOn: "2026-06-20" }
    ]
  });
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].conditionLineId, 501);
  assert.deepEqual(inputs[0].terms, { type: "revenue", base_amount: 1778400 + 890000, rate_pct: 5 });
  assert.equal(inputs[0].adjustments.mg_amount, 0);
  assert.equal(inputs[0].period, "2026-06");
  // ひも付け無しは記帳しない
  assert.equal(royaltyEventInputsFromStatement({ statementMode: "multi", rsInRatePct: 5, rs_receipts: [{ sublicensee: "A", amount: 100 }] }).length, 0);
});
