import test from "node:test";
import assert from "node:assert/strict";
import { isQuasiMandate, normalizeTimeSettlement, settleHours, timeSettlementLabel } from "./time-settlement.js";

test("時間精算でなければ 3 つの値は持たない", () => {
  assert.deepEqual(normalizeTimeSettlement({ timeSettlement: false, hoursIncluded: 64, overageUnitAmount: 3125 }),
    { timeSettlement: false, hoursIncluded: null, overageUnitAmount: null, shortfallUnitAmount: null });
  assert.deepEqual(normalizeTimeSettlement({}), { timeSettlement: false, hoursIncluded: null, overageUnitAmount: null, shortfallUnitAmount: null });
});

test("時間精算は包括枠と超過単価が要る。控除単価は任意", () => {
  assert.throws(() => normalizeTimeSettlement({ timeSettlement: true, overageUnitAmount: 3125 }), /包括枠/);
  assert.throws(() => normalizeTimeSettlement({ timeSettlement: true, hoursIncluded: 64 }), /超過単価/);
  assert.throws(() => normalizeTimeSettlement({ timeSettlement: true, hoursIncluded: 64, overageUnitAmount: 3125, shortfallUnitAmount: -1 }), /控除単価/);
  assert.deepEqual(normalizeTimeSettlement({ timeSettlement: true, hoursIncluded: 64, overageUnitAmount: 3125 }),
    { timeSettlement: true, hoursIncluded: 64, overageUnitAmount: 3125, shortfallUnitAmount: null });
});

test("実績時間から精算額：超過は加算、未消化は控除単価があるときだけ減額", () => {
  const terms = { timeSettlement: true, hoursIncluded: 64, overageUnitAmount: 3125, shortfallUnitAmount: null };
  const over = settleHours(terms, 200000, 72);
  assert.equal(over.overageHours, 8);
  assert.equal(over.overageAmount, 25000);
  assert.equal(over.hoursApplied, 64);
  assert.equal(over.shortfallAmount, 0);
  assert.equal(over.total, 225000);

  const under = settleHours(terms, 200000, 50);
  assert.equal(under.shortfallHours, 14);
  assert.equal(under.shortfallAmount, 0);
  assert.equal(under.total, 200000);

  const deduct = settleHours({ ...terms, shortfallUnitAmount: 3000 }, 200000, 50.5);
  assert.equal(deduct.shortfallHours, 13.5);
  assert.equal(deduct.shortfallAmount, 40500);
  assert.equal(deduct.total, 159500);

  // 実績が無ければ枠どおり（基本委託料だけ）。
  assert.equal(settleHours(terms, 200000, null).total, 200000);
});

test("契約形式が準委任か", () => {
  assert.equal(isQuasiMandate("準委任"), true);
  assert.equal(isQuasiMandate("請負／準委任"), true);
  assert.equal(isQuasiMandate("Quasi-mandate"), true);
  assert.equal(isQuasiMandate("請負"), false);
  assert.equal(isQuasiMandate(null), false);
});

test("表示の 1 行", () => {
  assert.equal(timeSettlementLabel({ timeSettlement: true, hoursIncluded: 64, overageUnitAmount: 3125, shortfallUnitAmount: null }, 200000),
    "包括枠 64 h／月 200,000 円、超過 3,125 円／h");
  assert.equal(timeSettlementLabel({ timeSettlement: false, hoursIncluded: null, overageUnitAmount: null, shortfallUnitAmount: null }, 1), "");
});
