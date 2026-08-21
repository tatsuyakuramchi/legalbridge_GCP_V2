import assert from "node:assert/strict";
import test from "node:test";
import { generatePaymentSchedule, normalizePaymentSchedule } from "./payment-schedule.js";

test("payment-schedule: 月次・翌月末払いは各月の翌月末日になる", () => {
  const rows = generatePaymentSchedule({
    calc_method: "SUBSCRIPTION", cycle: "MONTHLY", term_start: "2026-01-01", term_end: "2026-03-31",
    billing_day: 0, billing_timing: "NEXT_MONTH", unit_price: 100000
  }, 12);
  assert.deepEqual(rows.map((row) => row.date), ["2026-02-28", "2026-03-31", "2026-04-30"]);
  assert.ok(rows.every((row) => row.amount === 100000));
});

test("payment-schedule: 四半期・当月15日払い", () => {
  const rows = generatePaymentSchedule({
    cycle: "QUARTERLY", term_start: "2026-04-01", term_end: "2027-03-31",
    billing_day: 15, billing_timing: "SAME_MONTH", unit_price: 300
  }, 12);
  assert.deepEqual(rows.map((row) => row.date),
    ["2026-04-15", "2026-07-15", "2026-10-15", "2027-01-15"]);
});

test("payment-schedule: 終了日が無ければ回数分だけ生成する", () => {
  const rows = generatePaymentSchedule({
    cycle: "MONTHLY", term_start: "2026-01-01", billing_day: 25, unit_price: 500
  }, 3);
  assert.deepEqual(rows.map((row) => row.date), ["2026-01-25", "2026-02-25", "2026-03-25"]);
});

test("payment-schedule: 翌月払いの最終回は term_end より後でも欠けない", () => {
  // 役務提供期間ベースで打ち切るので、3月分の支払（4月末）が最終回として残る。
  const rows = generatePaymentSchedule({
    cycle: "MONTHLY", term_start: "2026-03-01", term_end: "2026-03-31",
    billing_day: 31, billing_timing: "NEXT_MONTH", unit_price: 100
  }, 12);
  assert.deepEqual(rows.map((row) => row.date), ["2026-04-30"]);
});

test("payment-schedule: billing_day 未設定は期間の起点日をそのまま使う", () => {
  const rows = generatePaymentSchedule({
    cycle: "MONTHLY", term_start: "2026-01-10", unit_price: 100
  }, 2);
  assert.deepEqual(rows.map((row) => row.date), ["2026-01-10", "2026-02-10"]);
});

test("payment-schedule: カスタム周期（日ベース）は日数刻みで支払日を並べる", () => {
  const rows = generatePaymentSchedule({
    cycle: "CUSTOM", interval_unit: "DAY", interval_count: 10,
    term_start: "2026-01-01", term_end: "2026-01-25", unit_price: 100
  }, 12);
  assert.deepEqual(rows.map((row) => row.date), ["2026-01-01", "2026-01-11", "2026-01-21"]);
});

test("payment-schedule: term_start が無い・不正なら空", () => {
  assert.deepEqual(generatePaymentSchedule({ cycle: "MONTHLY" }, 3), []);
  assert.deepEqual(generatePaymentSchedule({ cycle: "MONTHLY", term_start: "invalid" }, 3), []);
});

test("payment-schedule: 保存済み配列の正規化（不正要素は除外・金額は数値化）", () => {
  const rows = normalizePaymentSchedule([
    { date: "2026-06-30", amount: "1000" }, { date: "2026-09-30" }, null, "x", ["y"]
  ]);
  assert.deepEqual(rows, [
    { date: "2026-06-30", amount: 1000 }, { date: "2026-09-30", amount: undefined }
  ]);
  assert.deepEqual(normalizePaymentSchedule("not-array"), []);
});
