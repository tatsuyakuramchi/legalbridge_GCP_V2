import { test } from "node:test";
import assert from "node:assert/strict";
import { matrixSuggestedName, roundToMillion, shareProblem, sharePpmFromEffective } from "./matrix.js";

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

test("取り分：実質料率から 100 分率を出し、端数のずれは合計 100% にそろえる", () => {
  // 料率 11% を 10% と 1% に分ける
  assert.deepEqual(sharePpmFromEffective([100000, 10000], 110000), [909091, 90909]);
  // 料率 7% を 3 人で均等（割り切れない）
  const three = sharePpmFromEffective([23333, 23333, 23334], 70000);
  assert.equal(three.reduce((a, b) => a + b, 0), 1_000_000);
  // 合計が料率と違う（入力違い）ならそろえない
  assert.deepEqual(sharePpmFromEffective([50000, 10000], 110000), [454545, 90909]);
  assert.deepEqual(roundToMillion([333333.4, 333333.3, 333333.3]).reduce((a, b) => a + b, 0), 1_000_000);
});
