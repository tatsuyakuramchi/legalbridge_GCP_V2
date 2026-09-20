import test from "node:test";
import assert from "node:assert/strict";
import { DRIFT_LABEL, driftOf, hasDrift } from "./drift.js";
import type { GridRow } from "./grid.js";

/**
 * 条件を直したあとに、決定済みの文書へ焼き付いた額が取り残される。それを
 * 見つける。段ごとに比べる相手が違う（発注書は条件、検収書と支払は実績）。
 */

const settlement = (over: Partial<GridRow["settlement"]> = {}): GridRow["settlement"] => ({
  state: "open", done: false, eventCount: 0, deliveredAmount: 0, plannedAmount: 0,
  paidAmount: 0, targetAmount: 95000, closedAt: null, closedReason: null, ...over
});

const doc = (over: Partial<NonNullable<GridRow["order"]>> = {}) => ({
  id: 1, documentNo: "ARC-PO-2026-1033", phase: "decided",
  amountExTax: 120000, conditionCount: 1, ...over
});

const row = (over: Partial<GridRow> = {}): GridRow => ({
  conditionId: 1, conditionNo: "CL-1", name: "挿絵 5点", kind: "service",
  counterparty: { id: 10, name: "みなも工房" },
  pricingModel: "fixed", currency: "JPY", flatAmount: 95000, unitAmount: null, ratePpm: null,
  status: "active", settlement: settlement(),
  schedules: { total: 0, done: 0 },
  order: null, events: { count: 0, latestOn: null, latestId: null }, settlementDoc: null, payment: null,
  ...over
});

/** 実績1件の条件。検収書と支払はこの額と比べる。 */
const delivered = (amount: number, over: Partial<GridRow> = {}): GridRow => row({
  events: { count: 1, latestOn: "2026-09-01", latestId: 7 },
  settlement: settlement({ deliveredAmount: amount }),
  ...over
});

test("決定済みの発注書が、今の条件の金額と違えば鳴らす", () => {
  const r = row({ order: doc() });
  const d = driftOf(r)!;
  assert.equal(d.conditionAmount, 95000);
  assert.deepEqual(d.flagged.map((e) => [e.part, e.amount, e.basis, e.diff]),
    [["order", 120000, 95000, 25000]]);
  assert.equal(d.flagged[0].basisLabel, "条件");
  assert.equal(hasDrift(r), true);
});

test("下書きの文書は鳴らさない（決定のときに条件から引き直す）", () => {
  const r = row({ order: doc({ phase: "draft", amountExTax: null }) });
  assert.deepEqual(driftOf(r)!.entries, []);
  assert.equal(hasDrift(r), false);
});

test("条件と同じ額なら鳴らさない。比べたことは残す", () => {
  // 「確かめて合っていた」と「見ていない」は画面で別物。
  const d = driftOf(row({ order: doc({ amountExTax: 95000 }) }))!;
  assert.deepEqual(d.flagged, []);
  assert.equal(d.entries.length, 1);
});

test("条件を何本もまとめた文書は、1本ぶんと比べられないので鳴らさない", () => {
  const r = row({ order: doc({ conditionCount: 3 }) });
  const e = driftOf(r)!.entries[0];
  assert.equal(e.flagged, false);
  assert.match(e.note!, /条件 3 本/);
});

test("減額納品は食い違いではない（実績は条件と違ってよい）", () => {
  // 検収書は当初との差を変更履歴に出し、署名欄まで付ける作りになっている。
  // ここを鳴らすと、正しく処理した案件が軒並み食い違いになる。
  const r = delivered(60000);
  const e = driftOf(r)!.entries.find((x) => x.part === "event")!;
  assert.equal(e.diff, -35000);
  assert.equal(e.flagged, false);
  assert.match(e.note!, /減額納品/);
  assert.equal(hasDrift(r), false);
});

test("検収書と支払は、条件ではなく実績と比べる", () => {
  // 減額納品（実績 60,000）で、検収書も支払もその額なら合っている。
  const ok = delivered(60000, {
    settlementDoc: doc({ documentNo: "ARC-INS-1", amountExTax: 60000 }),
    settlement: settlement({ deliveredAmount: 60000, plannedAmount: 60000 }),
    payment: { id: 4, paymentNo: "PY-1", status: "planned", dueOn: null, note: null }
  });
  assert.deepEqual(driftOf(ok)!.flagged, []);
  assert.deepEqual(
    driftOf(ok)!.entries.filter((e) => e.part !== "event").map((e) => e.basisLabel),
    ["実績", "実績"]);

  // 実績を 60,000 に直したのに、検収書は 95,000 のまま。ここは鳴らす。
  const stale = delivered(60000, {
    settlementDoc: doc({ documentNo: "ARC-INS-1", amountExTax: 95000 }),
    settlement: settlement({ deliveredAmount: 60000 })
  });
  assert.deepEqual(driftOf(stale)!.flagged.map((e) => [e.part, e.diff]), [["settlementDoc", 35000]]);
});

test("実績がまだ無ければ、検収書と支払は条件と比べる", () => {
  const r = row({
    settlementDoc: doc({ documentNo: "ARC-INS-1", amountExTax: 120000 })
  });
  const e = driftOf(r)!.entries[0];
  assert.equal(e.basisLabel, "条件");
  assert.equal(e.flagged, true);
});

test("分納の途中は、食い違いではない", () => {
  // 予定2回の1回目だけ済んだ条件。実績も検収書も支払も半分で合っている。
  const r = delivered(47500, {
    schedules: { total: 2, done: 1 },
    settlementDoc: doc({ documentNo: "ARC-INS-1", amountExTax: 47500 }),
    settlement: settlement({ deliveredAmount: 47500, paidAmount: 47500 }),
    payment: { id: 4, paymentNo: "PY-1", status: "paid", dueOn: null, note: null }
  });
  assert.deepEqual(driftOf(r)!.flagged, []);
  assert.deepEqual(driftOf(r)!.entries.map((e) => e.part), ["event", "settlementDoc", "payment"]);
});

test("総額の決まらない条件は比べられない", () => {
  // 料率は「いくらであるべきか」が無い。食い違いも定義できない。
  const r = row({ pricingModel: "royalty", flatAmount: null, ratePpm: 50000, order: doc() });
  assert.equal(driftOf(r), null);
  assert.equal(hasDrift(r), false);
});

test("払い切ったあとでも鳴らす", () => {
  // 払ったあとに気づくほうが困る。決着と食い違いは別の軸。
  const r = row({
    settlement: settlement({ state: "paid", done: true, paidAmount: 95000 }),
    order: doc()
  });
  assert.equal(hasDrift(r), true);
});

test("段の名前が全部ある（画面の見出しに使う）", () => {
  for (const key of ["order", "settlementDoc", "event", "payment"] as const) {
    assert.ok(DRIFT_LABEL[key], `${key} の名前が無い`);
  }
});
