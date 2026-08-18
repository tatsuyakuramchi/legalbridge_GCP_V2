import assert from "node:assert/strict";
import test from "node:test";
import { backlogReadEnabled } from "./index.js";

// live は「起票できる」モードであって、読めなくなるモードではない。
// ここを readonly 限定にしていたせいで、live へ上げると依頼画面の課題一覧が空になっていた。
test("Backlog の読取は readonly でも live でも使える", () => {
  assert.equal(backlogReadEnabled("readonly"), true);
  assert.equal(backlogReadEnabled("live"), true);
});

test("disabled のときだけ読取を止める", () => {
  assert.equal(backlogReadEnabled("disabled"), false);
});
