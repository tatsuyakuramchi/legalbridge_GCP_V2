import assert from "node:assert/strict";
import test from "node:test";
import { calculateFee, grossOf } from "./calc.js";
import type { FeeTerms } from "./calc.js";

// ── gross モデル別（grossOf は税・調整なしの gross のみ） ──

test("固定額型 gross = ceil(単価 × 個数)、sample控除", () => {
  assert.equal(grossOf({ type: "fixed", unit_price: 1000, quantity: 10 }), 10000);
  // sample_quantity は grossOf では常に0（調整なし）
  const r = calculateFee({ type: "fixed", unit_price: 1000, quantity: 10 }, { sample_quantity: 2 }, 0);
  assert.equal(r.gross_ex_tax, 8000);
});

test("サブスク型 gross = ceil(期間額 × 期間数 + initial)", () => {
  assert.equal(grossOf({ type: "subscription", period_amount: 5000, period_count: 12 }), 60000);
  assert.equal(
    grossOf({ type: "subscription", period_amount: 5000, period_count: 12, initial_fee: 3000 }),
    63000
  );
});

test("業績連動型 gross = ceil(基準価格 × billable × 料率)", () => {
  assert.equal(grossOf({ type: "performance", base_price: 2000, rate_pct: 5, quantity: 100 }), 10000);
  const r = calculateFee(
    { type: "performance", base_price: 2000, rate_pct: 5, quantity: 100 },
    { sample_quantity: 10 },
    0
  );
  assert.equal(r.gross_ex_tax, 9000);
});

test("売上報告型 gross = ceil(報告金額 × 料率)、数量なし・端数切上", () => {
  // 123456 × 7% = 8641.92 → ceil 8642
  assert.equal(grossOf({ type: "revenue", base_amount: 123456, rate_pct: 7 }), 8642);
});

// ── 歩留率（acceptance_ratio） ──

test("歩留率は null/NaN→1.0、範囲外は0..1にclamp、ceilで丸め", () => {
  const perf: FeeTerms = { type: "performance", base_price: 2000, rate_pct: 5, quantity: 100 }; // gross 10000
  assert.equal(calculateFee(perf, {}, 0).after_acceptance, 10000); // null→1.0
  assert.equal(calculateFee(perf, { acceptance_ratio: 0.9 }, 0).after_acceptance, 9000);
  assert.equal(calculateFee(perf, { acceptance_ratio: 1.5 }, 0).after_acceptance, 10000); // clamp 1
  assert.equal(calculateFee(perf, { acceptance_ratio: -0.5 }, 0).after_acceptance, 0); // clamp 0
  assert.equal(calculateFee(perf, { acceptance_ratio: Number.NaN }, 0).after_acceptance, 10000); // NaN→1.0
  // ceil: gross 10001 × 0.5 = 5000.5 → 5001
  const odd = calculateFee({ type: "fixed", unit_price: 10001, quantity: 1 }, { acceptance_ratio: 0.5 }, 0);
  assert.equal(odd.after_acceptance, 5001);
});

// ── MG floor（最低保証・消化されない） ──

test("MG floor：グロス<MGならMGを採用しtopup計上、グロス≥MGなら不適用", () => {
  const perf: FeeTerms = { type: "performance", base_price: 1000, rate_pct: 10, quantity: 80 }; // gross 8000
  const low = calculateFee(perf, { mg_amount: 10000 }, 0);
  assert.equal(low.after_acceptance, 8000);
  assert.equal(low.actual_ex_tax, 10000);
  assert.equal(low.mg_topup_this_time, 2000);
  assert.equal(low.mg_floor_applied, true);

  const high = calculateFee(perf, { mg_amount: 6000 }, 0);
  assert.equal(high.actual_ex_tax, 8000);
  assert.equal(high.mg_topup_this_time, 0);
  assert.equal(high.mg_floor_applied, false);
  // 互換shape（deprecated）は固定値
  assert.equal(high.mg_consumed_this_time, 0);
  assert.equal(high.mg_fully_consumed, false);
});

// ── AG offset（前払保証・累積消化） ──

test("AG offset：残高から相殺、ag_consumed_beforeを反映、使い切りを検出", () => {
  const perf: FeeTerms = { type: "performance", base_price: 1000, rate_pct: 10, quantity: 100 }; // gross 10000
  // AG残潤沢：全額相殺で実支払0
  const full = calculateFee(perf, { ag_amount: 30000 }, 0);
  assert.equal(full.ag_offset_this_time, 10000);
  assert.equal(full.actual_ex_tax, 0);
  assert.equal(full.ag_remaining_after, 20000);
  assert.equal(full.ag_fully_consumed, false);

  // 既消化25000、残5000のみ相殺 → 実支払5000、使い切り
  const partial = calculateFee(perf, { ag_amount: 30000, ag_consumed_before: 25000 }, 0);
  assert.equal(partial.ag_offset_this_time, 5000);
  assert.equal(partial.actual_ex_tax, 5000);
  assert.equal(partial.ag_remaining_after, 0);
  assert.equal(partial.ag_fully_consumed, true);

  // AGなし
  const none = calculateFee(perf, {}, 0);
  assert.equal(none.ag_offset_this_time, 0);
  assert.equal(none.actual_ex_tax, 10000);
  assert.equal(none.ag_fully_consumed, false);
});

// ── 消費税（ceil） ──

test("消費税は ceil(税抜 × 税率)、税率既定10%、8%も可", () => {
  // revenue gross 8642 → tax ceil(864.2)=865
  const r = calculateFee({ type: "revenue", base_amount: 123456, rate_pct: 7 });
  assert.equal(r.actual_ex_tax, 8642);
  assert.equal(r.tax_rate, 10);
  assert.equal(r.tax_amount, 865);
  assert.equal(r.total_inc_tax, 9507);

  const r8 = calculateFee({ type: "fixed", unit_price: 10000, quantity: 1 }, {}, 8);
  assert.equal(r8.tax_amount, 800);
  assert.equal(r8.total_inc_tax, 10800);
});

// ── フルカスケード統合 ──

test("フルカスケード：gross→歩留→MG floor→AG offset→税", () => {
  // performance gross = ceil(1000×100×10%) = 10000
  const r = calculateFee(
    { type: "performance", base_price: 1000, rate_pct: 10, quantity: 100 },
    { acceptance_ratio: 0.8, mg_amount: 9000, ag_amount: 4000 },
    10
  );
  assert.equal(r.gross_ex_tax, 10000);
  assert.equal(r.after_acceptance, 8000); // ceil(10000×0.8)
  // MG floor: max(8000, 9000)=9000, topup 1000
  assert.equal(r.mg_topup_this_time, 1000);
  assert.equal(r.mg_floor_applied, true);
  // AG: min(9000, 4000)=4000 → actual 5000, 使い切り
  assert.equal(r.ag_offset_this_time, 4000);
  assert.equal(r.actual_ex_tax, 5000);
  assert.equal(r.ag_fully_consumed, true);
  // 税10%: ceil(500)=500
  assert.equal(r.tax_amount, 500);
  assert.equal(r.total_inc_tax, 5500);
});

test("formula_breakdown は非空で '=' を含む", () => {
  const r = calculateFee({ type: "performance", base_price: 2000, rate_pct: 5, quantity: 100 }, { sample_quantity: 10 }, 0);
  assert.ok(r.formula_breakdown.includes("="));
  assert.ok(r.formula_breakdown.includes("−")); // sample控除が式に現れる
});
