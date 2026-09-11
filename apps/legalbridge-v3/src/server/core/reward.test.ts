import test from "node:test";
import assert from "node:assert/strict";
import { calcMethodFor, ownershipLabelOf, rewardLabelFor } from "./reward.js";

test("料率は ROYALTY、単価×数量と定額は FIXED", () => {
  // 選択肢は FIXED / ROYALTY / SUBSCRIPTION の3つ。ここに無い値を返すと
  // 本文のどの枝にも当たらず、業績連動の内訳が一度も出ない。
  assert.equal(calcMethodFor("revenue_rate"), "ROYALTY");
  assert.equal(calcMethodFor("unit_rate"), "FIXED");
  assert.equal(calcMethodFor("fixed"), "FIXED");
  assert.equal(calcMethodFor("subscription"), "SUBSCRIPTION");
  assert.equal(calcMethodFor(null), "");
});

test("報酬の名前は帰属先で変わる", () => {
  assert.equal(rewardLabelFor("revenue_rate", "contractor"), "利用許諾料");
  assert.equal(rewardLabelFor("revenue_rate", "orderer"), "インセンティブ報酬");
});

test("帰属先が無ければ名前を決めない", () => {
  // 譲渡なのか許諾なのか分からないまま紙に載せない。
  assert.equal(rewardLabelFor("revenue_rate", null), null);
});

test("定額の条件は業績連動ではない", () => {
  assert.equal(rewardLabelFor("fixed", "contractor"), null);
  assert.equal(rewardLabelFor("unit_rate", "orderer"), null);
});

test("帰属先の日本語", () => {
  assert.equal(ownershipLabelOf("orderer"), "発注者");
  assert.equal(ownershipLabelOf("contractor"), "受注者");
  assert.equal(ownershipLabelOf(""), null);
});
