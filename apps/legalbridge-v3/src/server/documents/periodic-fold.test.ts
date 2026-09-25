import test from "node:test";
import assert from "node:assert/strict";
import { billingShape, foldPeriodicLines, intervalLabel, periodSummary } from "./periodic-fold.js";
import { deliveryLinesFrom, orderLinesFrom } from "./template-context.js";

type Row = Record<string, any>;

/** 定期課金の回。予定明細1回ぶんの発注明細と同じ形。 */
const beat = (over: Row = {}): Row => ({
  condition_id: 1, condition_name: "システム保守（月額）", item_name: "2026年4月分",
  spec: "月次の保守運用", quantity: 1, unit_price: 35000, amount_ex_tax: 35000,
  payment_terms: "委任", tax_category: "taxable", calc_method: "SUBSCRIPTION",
  delivery_date: "2026-04-30", payment_date: "2026-05-31", term_start: "2026-04-01",
  term_end: "2026-04-30", ...over
});

/** n 回ぶんの並び。月末の期日を1か月ずつ送る。 */
function beats(n: number, over: (i: number) => Row = () => ({})): Row[] {
  const ends = ["04-30", "05-31", "06-30", "07-31", "08-31", "09-30", "10-31", "11-30"];
  return Array.from({ length: n }, (_, i) => beat({
    item_name: `2026年${i + 4}月分`,
    delivery_date: `2026-${ends[i]}`,
    payment_date: `2026-${ends[i + 1] ?? ends[ends.length - 1]}`,
    term_start: `2026-${ends[i].slice(0, 2)}-01`,
    term_end: `2026-${ends[i]}`,
    ...over(i)
  }));
}

test("同じ内容の回は1行に畳まれ、数量が回数になる", () => {
  const out = foldPeriodicLines(beats(6));
  assert.equal(out.length, 1);
  assert.equal(out[0].item_name, "システム保守（月額）", "回の名前ではなく条件の名前を出す");
  assert.equal(out[0].quantity, 6);
  assert.equal(out[0].unit_price, 35000);
  assert.equal(out[0].amount_ex_tax, 210000, "6回ぶんの合計");
  assert.equal(out[0].period_count, 6);
  assert.equal(out[0].folded, true);
});

test("畳んだ行は期間と回数を仕様に書く", () => {
  const out = foldPeriodicLines(beats(6));
  assert.equal(out[0].period_interval, "毎月");
  assert.match(String(out[0].spec), /^月次の保守運用\n/, "もとの仕様は消さない");
  assert.match(String(out[0].spec), /2026年4月分 〜 2026年9月分/);
  assert.match(String(out[0].spec), /全6回（毎月）/);
  assert.match(String(out[0].spec), /1回あたり 35,000/);
});

test("畳んだ行の日付は最初と最後の範囲になる", () => {
  const out = foldPeriodicLines(beats(6));
  assert.equal(out[0].delivery_date, "2026-04-30 〜 2026-09-30");
  assert.equal(out[0].term_start, "2026-04-01");
  assert.equal(out[0].term_end, "2026-09-30");
});

test("金額の違う回はそこで切れる（1本にまとめない）", () => {
  const out = foldPeriodicLines(beats(6, (i) => (i === 3 ? { amount_ex_tax: 50000, unit_price: 50000 } : {})));
  assert.deepEqual(out.map((r) => r.period_count ?? 1), [3, 1, 2], "3回・単発・2回");
  assert.equal(out[1].item_name, "2026年7月分", "畳まれない回は回の名前のまま");
  assert.equal(out[1].amount_ex_tax, 50000);
});

test("変更の記録が付いた回は畳まない（減額の理由を紙から消さない）", () => {
  const out = foldPeriodicLines(beats(4, (i) => (
    i === 2 ? { changeNote: "作業範囲の縮小", ordered_amount_ex_tax: 35000,
                inspected_amount_ex_tax: 20000, amount_ex_tax: 20000 } : {})));
  assert.deepEqual(out.map((r) => r.period_count ?? 1), [2, 1, 1]);
  assert.equal(out[1].changeNote, "作業範囲の縮小");
});

test("予定額と実績額が違う回も畳まない", () => {
  const out = foldPeriodicLines(beats(4, (i) => (
    i === 1 ? { ordered_amount_ex_tax: 35000, amount_ex_tax: 30000, unit_price: 30000 } : {})));
  assert.deepEqual(out.map((r) => r.period_count ?? 1), [1, 1, 2]);
});

test("定期課金でない行は畳まない", () => {
  const out = foldPeriodicLines(beats(4, () => ({ calc_method: "FIXED" })));
  assert.equal(out.length, 4);
});

test("条件が違えば畳まない", () => {
  const out = foldPeriodicLines([
    beat({ condition_id: 1 }), beat({ condition_id: 1, delivery_date: "2026-05-31" }),
    beat({ condition_id: 2 }), beat({ condition_id: 2, delivery_date: "2026-05-31" })
  ]);
  assert.deepEqual(out.map((r) => r.period_count), [2, 2]);
});

test("1回しかない定期課金はそのまま（回の名前を残す）", () => {
  const out = foldPeriodicLines(beats(1));
  assert.equal(out.length, 1);
  assert.equal(out[0].item_name, "2026年4月分");
  assert.equal(out[0].folded, undefined);
});

test("間隔がばらけていれば「毎月」と書かない", () => {
  assert.equal(intervalLabel(["2026-04-30", "2026-05-31", "2026-06-30"]), "毎月");
  assert.equal(intervalLabel(["2026-04-30", "2026-07-31", "2026-10-31"]), "3か月ごと");
  assert.equal(intervalLabel(["2026-04-30", "2027-04-30"]), "毎年");
  assert.equal(intervalLabel(["2026-04-30", "2026-05-31", "2026-09-30"]), null);
  assert.equal(intervalLabel(["2026-04-30", null]), null);
});

test("期日が読めなくても回数と1回あたりは書く", () => {
  const summary = periodSummary(beats(3, () => ({ delivery_date: "" })));
  assert.match(summary, /全3回/);
  assert.match(summary, /1回あたり 35,000/);
  assert.doesNotMatch(summary, /毎月/);
});

// ---- 発注書・検収書からの経路 -------------------------------------------

const subscription = {
  id: 7, name: "システム保守（月額）", pricingModel: "subscription", flatAmount: 35000,
  taxCategory: "taxable", spec: "月次の保守運用"
};

test("発注書：定期課金の予定明細12回が1行になる", () => {
  const schedules = Array.from({ length: 12 }, (_, i) => ({
    id: i + 1, conditionId: 7, seq: i + 1, label: `${2026 + Math.floor((i + 3) / 12)}年${((i + 3) % 12) + 1}月分`,
    plannedAmount: 35000,
    dueOn: `${2026 + Math.floor((i + 3) / 12)}-${String(((i + 3) % 12) + 1).padStart(2, "0")}-28`,
    payOn: null
  }));
  const lines = orderLinesFrom({ conditions: [subscription], condition: subscription, schedules }) as Row[];
  assert.equal(lines.length, 1);
  assert.equal(lines[0].quantity, 12);
  assert.equal(lines[0].unit_price, 35000);
  assert.equal(lines[0].amount_ex_tax, 420000);
  assert.equal(lines[0].period_interval, "毎月");
});

test("検収書：同じ額の回をまとめて検収しても1行になる", () => {
  const events = [4, 5, 6, 7].map((m, i) => ({
    id: i + 1, conditionId: 7, occurredOn: `2026-0${m}-28`, inspectedOn: `2026-0${m}-28`,
    amount: 35000, plannedAmount: 35000, quantity: 1, deliverable: `2026年${m}月分`
  }));
  const lines = deliveryLinesFrom({ conditions: [subscription], condition: subscription, events }) as Row[];
  assert.equal(lines.length, 1);
  assert.equal(lines[0].inspected_quantity, 4);
  assert.equal(lines[0].inspected_amount_ex_tax, 140000);
  assert.equal(lines[0].ordered_amount_ex_tax, 140000, "予定額も回数ぶん");
  assert.equal(lines[0].inspection_date, "2026-04-28 〜 2026-07-28");
  assert.match(String(lines[0].spec_body), /全4回（毎月）/, "まとめは業務内容の行に回る");
});

// ---- 定期支払の刷り方 ---------------------------------------------------

test("畳んだ行は周期・支払日・支払月を回の並びから読む", () => {
  const out = foldPeriodicLines(beats(6));
  assert.equal(out[0].cycle, "MONTHLY");
  assert.equal(out[0].billing_day, 31, "末日は 31 で入れる");
  assert.equal(out[0].billing_timing, "NEXT_MONTH", "期日の翌月に払う並び");
});

test("四半期・半期・年次の周期も読む", () => {
  const quarterly = ["2026-04-30", "2026-07-31", "2026-10-31"]
    .map((d) => beat({ delivery_date: d, payment_date: d }));
  assert.equal(billingShape(quarterly).cycle, "QUARTERLY");
  const annual = ["2026-04-30", "2027-04-30"].map((d) => beat({ delivery_date: d, payment_date: d }));
  assert.equal(billingShape(annual).cycle, "ANNUAL");
  assert.equal(billingShape(annual).billing_timing, "SAME_MONTH");
});

test("支払日がばらけていれば書かない（当て推量で刷らない）", () => {
  const shape = billingShape([
    beat({ delivery_date: "2026-04-30", payment_date: "2026-05-20" }),
    beat({ delivery_date: "2026-05-31", payment_date: "2026-06-25" })
  ]);
  assert.equal(shape.cycle, "MONTHLY");
  assert.equal(shape.billing_day, undefined);
});

test("人が入れた周期は上書きしない", () => {
  const out = foldPeriodicLines(beats(6, (i) => (i === 0 ? { cycle: "ANNUAL" } : {})));
  assert.equal(out.length, 1);
  assert.equal(out[0].cycle, "ANNUAL");
});
