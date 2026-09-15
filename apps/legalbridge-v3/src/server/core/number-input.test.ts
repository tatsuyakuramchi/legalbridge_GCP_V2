import test from "node:test";
import assert from "node:assert/strict";
import { readNumberInput } from "./number-input.js";

test("桁区切りのカンマが入っていても読む", () => {
  // 試算の画面から貼ると入ってくる。以前はここで NaN → null になり、
  // 受領額の入っていない実績としてサーバへ送られていた。
  assert.equal(readNumberInput("810,479"), 810479);
  assert.equal(readNumberInput("1,100,000"), 1100000);
  assert.equal(readNumberInput("¥2,200,000"), 2200000);
});

test("全角の数字も読む", () => {
  assert.equal(readNumberInput("１２３４"), 1234);
});

test("空欄は null", () => {
  assert.equal(readNumberInput(""), null);
  assert.equal(readNumberInput("   "), null);
  assert.equal(readNumberInput(null), null);
});

test("数字として読めないものは 0 にせず null", () => {
  // 0 として通すと、金額の入っていない実績が黙って保存される。
  assert.equal(readNumberInput("abc"), null);
  assert.equal(readNumberInput("1,0a0"), null);
  assert.equal(readNumberInput("810,479円"), null);
  assert.equal(readNumberInput("1.2.3"), null);
});

test("小数と負の数はそのまま読む", () => {
  assert.equal(readNumberInput("7.35"), 7.35);
  assert.equal(readNumberInput("-500"), -500);
});
