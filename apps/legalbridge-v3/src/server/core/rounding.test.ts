import test from "node:test";
import assert from "node:assert/strict";
import { roundAmount } from "./rounding.js";

test("四捨五入。0.5 は切り上げる", () => {
  assert.equal(roundAmount(4999.5), 5000);
  assert.equal(roundAmount(4999.4), 4999);
  assert.equal(roundAmount(8421.875), 8422);
  assert.equal(roundAmount(157987.5), 157988);
  assert.equal(roundAmount(6187.5), 6188);
});

test("整数はそのまま", () => {
  assert.equal(roundAmount(150000), 150000);
  assert.equal(roundAmount(0), 0);
});

test("負の 0.5 も絶対値で丸める", () => {
  // Math.round(-0.5) は -0 になる（0 側へ寄る）。値引きの行で桁が狂う。
  assert.equal(roundAmount(-0.5), -1);
  assert.equal(roundAmount(-4999.5), -5000);
});

test("数にならないものは 0", () => {
  assert.equal(roundAmount(null), 0);
  assert.equal(roundAmount(undefined), 0);
  assert.equal(roundAmount("あ"), 0);
});
