import test from "node:test";
import assert from "node:assert/strict";
import { cycleFromText, deriveSettlementRule, normalizeSettlementRule, settlementRuleLabel } from "./settlement-mode.js";

test("型ごとに要る値だけ残す。一回きりは回数も周期も持たない", () => {
  assert.deepEqual(normalizeSettlementRule({ settlementMode: "once", settlementCount: 3, settlementCycle: "month" }),
    { mode: "once", count: null, cycle: null, graceDays: null });
  assert.deepEqual(normalizeSettlementRule({ settlementMode: "fixed_count", settlementCount: 3 }),
    { mode: "fixed_count", count: 3, cycle: null, graceDays: null });
  assert.deepEqual(normalizeSettlementRule({ settlementMode: "term_bound", settlementCycle: "quarter", settlementGraceDays: 30 }),
    { mode: "term_bound", count: null, cycle: "quarter", graceDays: 30 });
  assert.deepEqual(normalizeSettlementRule({ settlementMode: "open" }),
    { mode: "open", count: null, cycle: null, graceDays: null });
  assert.deepEqual(normalizeSettlementRule({}), { mode: null, count: null, cycle: null, graceDays: null });
});

test("要る値が無ければ断る", () => {
  assert.throws(() => normalizeSettlementRule({ settlementMode: "fixed_count" }), /回数/);
  assert.throws(() => normalizeSettlementRule({ settlementMode: "fixed_count", settlementCount: 1 }), /一回きり/);
  assert.throws(() => normalizeSettlementRule({ settlementMode: "term_bound" }), /周期/);
  assert.throws(() => normalizeSettlementRule({ settlementMode: "open", settlementGraceDays: -1 }), /猶予/);
});

test("既存の条件から型を推す：イベント式→無制限、定期→期間、複数行→回数固定、ほかは一回きり", () => {
  const base = { kind: "service", scheduleCount: 1, periodicScheduleCount: 0 };
  assert.equal(deriveSettlementRule(base).mode, "once");
  assert.equal(deriveSettlementRule({ ...base, scheduleCount: 3 }).mode, "fixed_count");
  assert.equal(deriveSettlementRule({ ...base, scheduleCount: 3 }).count, 3);
  assert.deepEqual(deriveSettlementRule({ ...base, scheduleCount: 12, periodicScheduleCount: 12, cycle: "月次" }),
    { mode: "term_bound", count: null, cycle: "month", graceDays: null });
  assert.equal(deriveSettlementRule({ kind: "license", statementTiming: "event", scheduleCount: 0, periodicScheduleCount: 0 }).mode, "open");
  assert.equal(deriveSettlementRule({ kind: "license", usageType: "pub_print", scheduleCount: 0, periodicScheduleCount: 0 }).mode, "open");
  const lic = deriveSettlementRule({ kind: "license", statementTiming: "periodic", scheduleCount: 0, periodicScheduleCount: 0 });
  assert.equal(lic.mode, "term_bound");
  assert.equal(lic.cycle, "quarter", "許諾で周期が読めなければ四半期");
});

test("自由入力の周期を読む", () => {
  assert.equal(cycleFromText("月次"), "month");
  assert.equal(cycleFromText("四半期ごと"), "quarter");
  assert.equal(cycleFromText("半年"), "half_year");
  assert.equal(cycleFromText("年1回"), "year");
  assert.equal(cycleFromText("3か月ごと"), "quarter");
  assert.equal(cycleFromText("随時"), null);
  assert.equal(cycleFromText(null), null);
});

test("画面の 1 行", () => {
  assert.equal(settlementRuleLabel({ mode: "fixed_count", count: 3, cycle: null, graceDays: null }), "回数固定 3 回");
  assert.equal(settlementRuleLabel({ mode: "term_bound", count: null, cycle: "quarter", graceDays: null }), "期間で決まる・四半期ごと");
  assert.equal(settlementRuleLabel({ mode: "open", count: null, cycle: null, graceDays: null }), "回数無制限（終了後 60 日まで）");
  assert.equal(settlementRuleLabel({ mode: null, count: null, cycle: null, graceDays: null }), "未設定");
});
