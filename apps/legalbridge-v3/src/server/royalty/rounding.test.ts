import test from "node:test";
import assert from "node:assert/strict";
import { floorTax, roundRoyalty, taxOf } from "./rounding.js";

test("利用許諾料は四捨五入", () => {
  assert.equal(roundRoyalty(100.4), 100);
  assert.equal(roundRoyalty(100.5), 101);
  assert.equal(roundRoyalty(100.6), 101);
  // 736,799 × 10% = 73,679.9 → 73,680
  assert.equal(roundRoyalty(736799 * 0.1), 73680);
  // 532,608 × 10% = 53,260.8 → 53,261
  assert.equal(roundRoyalty(532608 * 0.1), 53261);
});

test("消費税は切り捨て", () => {
  assert.equal(taxOf(126941, 10), 12694);
  assert.equal(taxOf(100, 10), 10);
  assert.equal(taxOf(105, 10), 10, "10.5 は切り捨てて 10");
  assert.equal(floorTax(12694.1), 12694);
});

test("税率0・税率なしは0", () => {
  assert.equal(taxOf(126941, 0), 0);
  assert.equal(taxOf(0, 10), 0);
});
