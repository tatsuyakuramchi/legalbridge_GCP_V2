import test from "node:test";
import assert from "node:assert/strict";
import { money, redraftManualInputs } from "./reprice.js";

/**
 * 訂正版に引き継いだ手入力を引き直す。引き直せないものは引き直さず、
 * 理由つきで人に渡す（按分や日付の付け替えは、打ち合わせで決めた内訳と
 * 違う紙を出してしまう）。
 */

const items = (over: Record<string, unknown> = {}) => [{
  item_name: "表紙イラスト", spec: "カラー1点", quantity: 1, unit_price: 120000,
  amount_ex_tax: 120000, calc_method: "FIXED",
  delivery_date: "2026-11-30", payment_date: "2026-12-31", ...over
}];
const order = (over: Record<string, unknown> = {}) => ({ items: items(), _batchId: 2, ...over });
const rowsOf = (r: { manual: Record<string, unknown> }) =>
  r.manual.items as Array<Record<string, unknown>>;

// ---- 金額 -----------------------------------------------------------------

test("明細が1本なら、金額と単価を引き直す", () => {
  const r = redraftManualInputs(order(), { amountExTax: 95000 })!;
  assert.equal(rowsOf(r)[0].amount_ex_tax, 95000);
  assert.equal(rowsOf(r)[0].unit_price, 95000);
  // 触っていない欄はそのまま（業務内容や納品日を巻き添えにしない）。
  assert.equal(rowsOf(r)[0].spec, "カラー1点");
  assert.equal(rowsOf(r)[0].delivery_date, "2026-11-30");
  assert.deepEqual(r.lines, ["表紙イラスト ¥120,000 → ¥95,000"]);
  assert.deepEqual(r.pending, []);
  // 元の manual は書き換えない。
  assert.equal(order().items[0].amount_ex_tax, 120000);
});

test("個数があれば単価を割り直す", () => {
  const r = redraftManualInputs(
    order({ items: items({ quantity: 5, unit_price: 24000 }) }), { amountExTax: 95000 })!;
  assert.equal(rowsOf(r)[0].amount_ex_tax, 95000);
  assert.equal(rowsOf(r)[0].unit_price, 19000);
});

test("個数で割り切れないときは引き直さず、理由を返す", () => {
  // 単価 ¥19,000.4 の紙は出せない。人が内訳を決める。
  const r = redraftManualInputs(
    order({ items: items({ quantity: 7 }) }), { amountExTax: 95000 })!;
  assert.deepEqual(r.lines, []);
  assert.match(r.pending[0], /個数 7 で割り切れません/);
});

test("明細が2本以上なら引き直さず、理由を返す", () => {
  const r = redraftManualInputs({ items: [
    { item_name: "表紙", amount_ex_tax: 80000 }, { item_name: "口絵", amount_ex_tax: 40000 }
  ] }, { amountExTax: 95000 })!;
  assert.deepEqual(r.lines, []);
  assert.match(r.pending[0], /明細が 2 行あり/);
});

test("経費・手数料に金額があれば引き直さない", () => {
  const r = redraftManualInputs(
    order({ expenses: [{ item_name: "取材交通費", amount_inc_tax: 13000 }] }),
    { amountExTax: 95000 })!;
  assert.deepEqual(r.lines, []);
  assert.match(r.pending[0], /経費・手数料/);
});

// ---- 日付 -----------------------------------------------------------------

test("明細の納品日・支払期日を引き直す", () => {
  const r = redraftManualInputs(order(),
    { deliveryOn: "2026-12-15", paymentOn: "2027-01-31" })!;
  assert.equal(rowsOf(r)[0].delivery_date, "2026-12-15");
  assert.equal(rowsOf(r)[0].payment_date, "2027-01-31");
  assert.deepEqual(r.lines, ["納品日 2026-11-30 → 2026-12-15", "支払期日 2026-12-31 → 2027-01-31"]);
  // 金額を渡していないので、金額は触らない。
  assert.equal(rowsOf(r)[0].amount_ex_tax, 120000);
});

test("同じ日付が何行に入っていても、まとめて引き直す", () => {
  const r = redraftManualInputs({ items: [
    { item_name: "表紙", delivery_date: "2026-11-30" },
    { item_name: "口絵", delivery_date: "2026-11-30" }
  ] }, { deliveryOn: "2026-12-15" })!;
  assert.deepEqual(rowsOf(r).map((x) => x.delivery_date), ["2026-12-15", "2026-12-15"]);
});

test("明細ごとに日付が違えば引き直さず、理由を返す", () => {
  // 回ごとにずらしてあるなら、それは人が意図して並べたもの。
  const r = redraftManualInputs({ items: [
    { item_name: "表紙", delivery_date: "2026-11-30" },
    { item_name: "口絵", delivery_date: "2026-12-20" }
  ] }, { deliveryOn: "2026-12-15" })!;
  assert.deepEqual(r.lines, []);
  assert.match(r.pending[0], /明細ごとに違う日/);
});

test("日付の入っていない明細には入れない", () => {
  // 出していない欄に勝手に日付を入れると、紙の項目が増える。
  assert.equal(redraftManualInputs({ items: [{ item_name: "表紙" }] },
    { deliveryOn: "2026-12-15" }), null);
});

// ---- 金額と日付を一度に ----------------------------------------------------

test("金額と日付を一度に引き直す", () => {
  const r = redraftManualInputs(order(),
    { amountExTax: 95000, deliveryOn: "2026-12-15", paymentOn: "2027-01-31" })!;
  const item = rowsOf(r)[0];
  assert.equal(item.amount_ex_tax, 95000);
  assert.equal(item.unit_price, 95000);
  assert.equal(item.delivery_date, "2026-12-15");
  assert.equal(item.payment_date, "2027-01-31");
  assert.equal(r.lines.length, 3, r.lines.join(" / "));
});

test("片方だけ引き直せるときは、直したぶんと残りを両方返す", () => {
  const r = redraftManualInputs({ items: [
    { item_name: "表紙", amount_ex_tax: 80000, delivery_date: "2026-11-30" },
    { item_name: "口絵", amount_ex_tax: 40000, delivery_date: "2026-11-30" }
  ] }, { amountExTax: 95000, deliveryOn: "2026-12-15" })!;
  assert.deepEqual(r.lines, ["納品日 2026-11-30 → 2026-12-15"]);
  assert.match(r.pending[0], /明細が 2 行/);
});

test("直すところが無ければ null", () => {
  assert.equal(redraftManualInputs(order(), { amountExTax: 120000 }), null);
  assert.equal(redraftManualInputs({}, { amountExTax: 95000 }), null);
  assert.equal(redraftManualInputs({ items: [] }, { amountExTax: 95000 }), null);
  // 業務内容だけの手入力は条件から値を引くので、放っておいてよい。
  assert.equal(redraftManualInputs({ items: [{ spec: "A4 カラー" }] }, { amountExTax: 95000 }), null);
  // 渡さなかった欄は見ない。
  assert.equal(redraftManualInputs(order(), {}), null);
});

test("整形済みの数も読む", () => {
  assert.equal(money("120,000"), 120000);
  assert.equal(money("¥95,000"), 95000);
  assert.equal(money(""), null);
  assert.equal(money(null), null);
  assert.equal(money("未定"), null);
  const r = redraftManualInputs({ items: [{ item_name: "挿絵", amount_ex_tax: "120,000" }] },
    { amountExTax: 95000 })!;
  assert.equal(rowsOf(r)[0].amount_ex_tax, 95000);
});
