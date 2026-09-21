import test from "node:test";
import assert from "node:assert/strict";
import { amountOf, changesBetween, diffSettled, rowKey } from "./settled-diff.js";

const row = (over: Record<string, unknown> = {}) => ({
  partyName: "受託者名", conditionNo: "CL-2026-00001",
  conditionName: "挿絵 制作委託", item_name: "挿絵",
  quantity: "12", unit_price: "8000", inspectedQuantity: "", varianceNote: "",
  orderedOn: "2026-06-01", deliveredOn: "2026-07-22", inspectedOn: "2026-07-25",
  dueOn: "2026-09-30", paymentState: "未払", ...over
});

test("変わった列だけを並べる", () => {
  const changes = changesBetween(row(), row({ unit_price: "7000", varianceNote: "単価の誤り" }));
  assert.deepEqual(changes.map((c) => c.key), ["unit_price", "varianceNote"]);
  assert.equal(changes[0]?.label, "単価（税抜）");
  assert.equal(changes[0]?.before, "8000");
  assert.equal(changes[0]?.after, "7000");
});

test("数量と単価は書き方の違いで「変わった」と言わない", () => {
  assert.deepEqual(changesBetween(row(), row({ quantity: "12.0" })), []);
  assert.deepEqual(changesBetween(row(), row({ unit_price: " 8000 " })), []);
  // 文字の列はそのまま比べる（「請負」と「 請負 」は trim で揃う）。
  assert.deepEqual(changesBetween(row(), row({ paymentState: "支払済み" })).map((c) => c.key),
    ["paymentState"]);
});

test("行は条件名＋品目名で合わせる（並びで合わせない）", () => {
  const before = [row({ item_name: "表紙" }), row({ item_name: "挿絵" })];
  // 上げ直す CSV で並びが逆でも、同じ行として突き合わせる。
  const after = [row({ item_name: "挿絵", unit_price: "7000" }), row({ item_name: "表紙" })];
  const diff = diffSettled(before, after);
  assert.equal(diff.summary.changed, 1);
  assert.equal(diff.summary.same, 1);
  assert.equal(diff.summary.added, 0);
  assert.equal(diff.rows[0]?.itemName, "挿絵");
  assert.equal(diff.rows[0]?.kind, "changed");
});

test("足した行・消した行を見分ける", () => {
  const diff = diffSettled(
    [row({ item_name: "表紙" }), row({ item_name: "挿絵" })],
    [row({ item_name: "挿絵" }), row({ item_name: "口絵" })]);
  assert.equal(diff.summary.added, 1);
  assert.equal(diff.summary.removed, 1);
  assert.equal(diff.rows.find((r) => r.kind === "added")?.itemName, "口絵");
  assert.equal(diff.rows.find((r) => r.kind === "removed")?.itemName, "表紙");
});

test("合計は検収数量で計算する（減額検収）", () => {
  assert.equal(amountOf(row()), 96000);
  assert.equal(amountOf(row({ inspectedQuantity: "11" })), 88000);
  assert.equal(amountOf(row({ quantity: "", unit_price: "150000" })), 150000);
  assert.equal(amountOf(row({ unit_price: "" })), null);
});

test("合計の増減を出す（いくら変わるのかが本題）", () => {
  const diff = diffSettled(
    [row({ item_name: "表紙", quantity: "1", unit_price: "150000" }),
     row({ item_name: "挿絵", inspectedQuantity: "11" })],
    [row({ item_name: "表紙", quantity: "1", unit_price: "150000" }),
     row({ item_name: "挿絵", inspectedQuantity: "10" })]);
  assert.equal(diff.summary.beforeTotal, 238000);
  assert.equal(diff.summary.afterTotal, 230000);
  assert.equal(diff.summary.delta, -8000);
});

test("変わった行を上に、同じ行を下に出す", () => {
  const diff = diffSettled(
    [row({ item_name: "あ" }), row({ item_name: "い" }), row({ item_name: "う" })],
    [row({ item_name: "あ" }), row({ item_name: "い", unit_price: "1" }), row({ item_name: "え" })]);
  assert.deepEqual(diff.rows.map((r) => r.kind), ["changed", "added", "removed", "same"]);
});

test("同じ条件に同じ品目が2行あれば、決められないと言う", () => {
  const diff = diffSettled([row(), row({ unit_price: "9000" })], [row()]);
  assert.deepEqual(diff.ambiguous, ["挿絵 制作委託／挿絵"]);
  // 決められない行を黙って「変わった」と言わない。1行目だけを比べる。
  assert.equal(diff.summary.same, 1);
  assert.equal(diff.summary.changed, 0);
});

test("鍵は条件番号と品目名で作る（条件名を直しただけで別の行にしない）", () => {
  assert.equal(rowKey(row({ conditionName: "名前を直した" })), rowKey(row()));
  assert.notEqual(rowKey(row({ conditionNo: "CL-2" })), rowKey(row()));
  assert.equal(rowKey(row({ dueOn: "2027-01-01" })), rowKey(row()));
});

test("条件番号が無ければ条件名で合わせる（人が手で作った CSV）", () => {
  const noNo = (over: Record<string, unknown> = {}) => row({ conditionNo: "", ...over });
  assert.notEqual(rowKey(noNo({ conditionName: "A" })), rowKey(noNo({ conditionName: "B" })));
  assert.equal(rowKey(noNo()), rowKey(noNo()));
});

test("条件名を直しても、金額の差として読める", () => {
  const diff = diffSettled([row()], [row({ conditionName: "名前を直した", unit_price: "7000" })]);
  assert.equal(diff.summary.changed, 1);
  assert.equal(diff.summary.added, 0);
  assert.equal(diff.summary.removed, 0);
  assert.deepEqual(diff.rows[0]?.fields.map((f) => f.key), ["conditionName", "unit_price"]);
});

test("空の突き合わせでも落ちない", () => {
  const diff = diffSettled([], []);
  assert.deepEqual(diff.rows, []);
  assert.equal(diff.summary.delta, 0);
});
