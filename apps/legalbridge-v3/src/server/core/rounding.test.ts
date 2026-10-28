import test from "node:test";
import assert from "node:assert/strict";
import { roundAmount, taxRoundingOf, taxWithRounding } from "./rounding.js";

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

test("消費税の端数処理：画面の選択肢の文字でも英字でも読む。空・読めない値は切り上げ", () => {
  assert.equal(taxRoundingOf("切り捨て"), "floor");
  assert.equal(taxRoundingOf("四捨五入"), "round");
  assert.equal(taxRoundingOf("切り上げ"), "ceil");
  assert.equal(taxRoundingOf("floor"), "floor");
  assert.equal(taxRoundingOf(" ROUND "), "round");
  assert.equal(taxRoundingOf(""), "ceil");
  assert.equal(taxRoundingOf(undefined), "ceil");
  assert.equal(taxRoundingOf("なにか"), "ceil");
});

test("消費税額を選んだ丸め方で出す", () => {
  // 12,345 × 10% = 1,234.5
  assert.equal(taxWithRounding(12345, 10, "ceil"), 1235);
  assert.equal(taxWithRounding(12345, 10, "floor"), 1234);
  assert.equal(taxWithRounding(12345, 10, "round"), 1235);
  // 12,344 × 10% = 1,234.4
  assert.equal(taxWithRounding(12344, 10, "round"), 1234);
  assert.equal(taxWithRounding(12344, 10, "ceil"), 1235);
  // 割り切れる額はどれでも同じ
  for (const mode of ["ceil", "floor", "round"] as const) assert.equal(taxWithRounding(280000, 10, mode), 28000);
});

test("軽減 8% を小数で掛けない（1250 × 0.08 が 100.00000000000001 になり、切り上げで 101 円になる）", () => {
  assert.equal(taxWithRounding(1250, 8, "ceil"), 100);
  assert.equal(taxWithRounding(0, 10, "ceil"), 0);
});
