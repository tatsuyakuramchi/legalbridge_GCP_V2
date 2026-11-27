import { test } from "node:test";
import assert from "node:assert/strict";
import { matrixSuggestedName, shareProblem } from "./matrix.js";

test("取引モデル名：書き方の違いを規則の名前（作品名｜取引モデル）に寄せる", () => {
  assert.equal(matrixSuggestedName("星降る夜のはなし｜電子版", "星降る夜のはなし", "pub_digital", null, null), "星降る夜のはなし｜電子出版");
  assert.equal(matrixSuggestedName("月の裏側の図書館(電子書籍)", "月の裏側の図書館", "pub_digital", null, null), "月の裏側の図書館｜電子出版");
  assert.equal(matrixSuggestedName("星降る夜のはなし2 電子", "星降る夜のはなし 2", "pub_digital", null, null), "星降る夜のはなし 2｜電子出版");
  assert.equal(matrixSuggestedName("星降る夜のはなし 紙", "星降る夜のはなし", "pub_print", null, null), "星降る夜のはなし｜紙出版");
  assert.equal(matrixSuggestedName("星降る夜のはなし｜再許諾（紙）", "星降る夜のはなし", "pub_sub_print", null, "translation"),
    "星降る夜のはなし｜翻訳版再許諾（紙）");
});

test("取引モデル名：もう規則どおり・目的を書いた名前・取引モデルが無い条件は勧めない", () => {
  assert.equal(matrixSuggestedName("星降る夜のはなし｜電子出版", "星降る夜のはなし", "pub_digital", null, null), null);
  assert.equal(matrixSuggestedName("星降る夜のはなし｜商品化", "星降る夜のはなし", "in_house", null, null), null);
  assert.equal(matrixSuggestedName("電子工作入門｜紙", "電子工作入門", "pub_digital", null, null), null);
  assert.equal(matrixSuggestedName("何か", "何か", null, null, null), null);
});

test("取引モデル名：相手と目的の（ ）は残す", () => {
  assert.equal(matrixSuggestedName("ゲームA 再許諾(B社／英語版)", "ゲームA", "sublicense", null, null), "ゲームA｜再許諾（B社／英語版）");
});

test("取り分：合計 100%・重なり・0 を確かめる", () => {
  assert.equal(shareProblem([]), null);
  assert.equal(shareProblem([{ partyId: 1, sharePpm: 700000 }, { partyId: 2, sharePpm: 300000 }]), null);
  assert.match(shareProblem([{ partyId: 1, sharePpm: 700000 }, { partyId: 2, sharePpm: 200000 }]) ?? "", /90%/);
  assert.match(shareProblem([{ partyId: 1, sharePpm: 500000 }, { partyId: 1, sharePpm: 500000 }]) ?? "", /2 回/);
});
