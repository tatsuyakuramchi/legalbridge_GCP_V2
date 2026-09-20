import test from "node:test";
import assert from "node:assert/strict";
import { money, repriceManualAmounts } from "./reprice.js";

/**
 * 訂正版に引き継いだ手入力を引き直す。引き直せないものは引き直さない
 * （按分すると、打ち合わせで決めた内訳と違う紙が出る）。
 */

const order = (over: Record<string, unknown> = {}) => ({
  items: [{
    item_name: "表紙イラスト", spec: "カラー1点", quantity: 1, unit_price: 120000,
    amount_ex_tax: 120000, calc_method: "FIXED", delivery_date: "2026-11-30"
  }],
  _batchId: 2, ...over
});

test("明細が1本なら、金額と単価を引き直す", () => {
  const r = repriceManualAmounts(order(), 95000)!;
  const item = (r.manual.items as Array<Record<string, unknown>>)[0];
  assert.equal(item.amount_ex_tax, 95000);
  assert.equal(item.unit_price, 95000);
  // 触っていない欄はそのまま（業務内容や納品日を巻き添えにしない）。
  assert.equal(item.spec, "カラー1点");
  assert.equal(item.delivery_date, "2026-11-30");
  assert.equal(r.line, "表紙イラスト ¥120,000 → ¥95,000");
  // 元の manual は書き換えない。
  assert.equal((order().items)[0].amount_ex_tax, 120000);
});

test("個数があれば単価を割り直す", () => {
  const r = repriceManualAmounts(order({
    items: [{ item_name: "挿絵", quantity: 5, unit_price: 24000, amount_ex_tax: 120000 }]
  }), 95000)!;
  const item = (r.manual.items as Array<Record<string, unknown>>)[0];
  assert.equal(item.amount_ex_tax, 95000);
  assert.equal(item.unit_price, 19000);
});

test("個数で割り切れないときは引き直さない", () => {
  // 単価 ¥19,000.4 の紙は出せない。人が内訳を決める。
  assert.equal(repriceManualAmounts(order({
    items: [{ item_name: "挿絵", quantity: 7, unit_price: 24000, amount_ex_tax: 120000 }]
  }), 95000), null);
});

test("明細が2本以上なら引き直さない", () => {
  // どの行が減ったのかは書いた人にしか分からない。按分は嘘になる。
  assert.equal(repriceManualAmounts(order({
    items: [{ item_name: "表紙", amount_ex_tax: 80000 }, { item_name: "口絵", amount_ex_tax: 40000 }]
  }), 95000), null);
});

test("経費・手数料に金額があれば引き直さない", () => {
  // 合計が明細だけでは決まらない。
  assert.equal(repriceManualAmounts(order({
    expenses: [{ item_name: "取材交通費", amount_inc_tax: 13000 }]
  }), 95000), null);
});

test("手入力に金額が無ければ、そもそも引き直すものが無い", () => {
  assert.equal(repriceManualAmounts({}, 95000), null);
  assert.equal(repriceManualAmounts({ items: [] }, 95000), null);
  // 業務内容だけの手入力は条件から金額を引くので、放っておいてよい。
  assert.equal(repriceManualAmounts({ items: [{ spec: "A4 カラー" }] }, 95000), null);
});

test("すでに新しい金額なら何もしない", () => {
  assert.equal(repriceManualAmounts(order(), 120000), null);
});

test("整形済みの数も読む", () => {
  assert.equal(money("120,000"), 120000);
  assert.equal(money("¥95,000"), 95000);
  assert.equal(money(""), null);
  assert.equal(money(null), null);
  assert.equal(money("未定"), null);
  const r = repriceManualAmounts({ items: [{ item_name: "挿絵", amount_ex_tax: "120,000" }] }, 95000)!;
  assert.equal((r.manual.items as Array<Record<string, unknown>>)[0].amount_ex_tax, 95000);
});
