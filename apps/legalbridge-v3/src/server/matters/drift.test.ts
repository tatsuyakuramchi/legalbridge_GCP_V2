import test from "node:test";
import assert from "node:assert/strict";
import { DRIFT_LABEL, FIELD_LABEL, driftOf, driftSummary, hasDrift, repairPlan } from "./drift.js";
import type { GridRow } from "./grid.js";

/**
 * 条件を直したあとに、決定済みの文書へ焼き付いた金額と日付が取り残される。
 * それを見つける。段ごとに比べる相手が違う（発注書は条件と予定、検収書は実績）。
 */

const settlement = (over: Partial<GridRow["settlement"]> = {}): GridRow["settlement"] => ({
  state: "open", done: false, eventCount: 0, deliveredAmount: 0, plannedAmount: 0,
  paidAmount: 0, targetAmount: 95000, closedAt: null, closedReason: null, ...over
});

const doc = (over: Partial<NonNullable<GridRow["order"]>> = {}) => ({
  id: 1, documentNo: "ARC-PO-2026-1033", phase: "decided",
  amountExTax: 120000, conditionCount: 1, siblingCount: 1,
  deliveryOn: null, inspectionOn: null, paymentOn: null, ...over
});

const row = (over: Partial<GridRow> = {}): GridRow => ({
  conditionId: 1, conditionNo: "CL-1", name: "挿絵 5点", kind: "service",
  counterparty: { id: 10, name: "みなも工房" },
  pricingModel: "fixed", currency: "JPY", flatAmount: 95000, unitAmount: null, ratePpm: null,
  status: "active", settlement: settlement(),
  schedules: { total: 0, done: 0, dueOn: null, payOn: null, dueVaries: false, payVaries: false },
  order: null,
  events: { count: 0, latestOn: null, latestId: null, latestInspectedOn: null },
  settlementDoc: null, payment: null,
  ...over
});

/** 実績1件の条件。検収書と支払はこの実績と比べる。 */
const delivered = (amount: number, over: Partial<GridRow> = {}): GridRow => row({
  events: { count: 1, latestOn: "2026-09-01", latestId: 7, latestInspectedOn: "2026-09-01" },
  settlement: settlement({ deliveredAmount: amount }),
  ...over
});

const seen = (r: GridRow) => driftOf(r)!.flagged.map((e) => [e.part, e.field, e.value, e.basis]);

// ---- 金額 -----------------------------------------------------------------

test("決定済みの発注書が、今の条件の金額と違えば鳴らす", () => {
  const r = row({ order: doc() });
  assert.deepEqual(seen(r), [["order", "amount", 120000, 95000]]);
  assert.equal(driftOf(r)!.flagged[0].diff, 25000);
  assert.equal(hasDrift(r), true);
});

test("下書きの文書は鳴らさない（決定のときに条件から引き直す）", () => {
  const r = row({ order: doc({ phase: "draft", amountExTax: null, deliveryOn: "2026-01-01" }),
                  schedules: { total: 1, done: 0, dueOn: "2026-11-30", payOn: null,
                               dueVaries: false, payVaries: false } });
  assert.deepEqual(driftOf(r)!.entries, []);
});

test("条件と同じ額なら鳴らさない。比べたことは残す", () => {
  const d = driftOf(row({ order: doc({ amountExTax: 95000 }) }))!;
  assert.deepEqual(d.flagged, []);
  assert.equal(d.entries.length, 1);
});

test("条件を何本もまとめた文書は、1本ぶんと比べられないので鳴らさない", () => {
  const e = driftOf(row({ order: doc({ conditionCount: 3 }) }))!.entries[0];
  assert.equal(e.flagged, false);
  assert.match(e.note!, /条件 3 本/);
});

test("減額納品は食い違いではない（実績の金額は条件と違ってよい）", () => {
  // 検収書は当初との差を変更履歴に出し、署名欄まで付ける作りになっている。
  // ここを鳴らすと、正しく処理した案件が軒並み食い違いになる。
  const r = delivered(60000);
  const e = driftOf(r)!.entries.find((x) => x.part === "event")!;
  assert.equal(e.diff, -35000);
  assert.equal(e.flagged, false);
  assert.match(e.note!, /減額納品/);
  assert.equal(hasDrift(r), false);
});

test("検収書と支払の金額は、条件ではなく実績と比べる", () => {
  const ok = delivered(60000, {
    settlementDoc: doc({ documentNo: "ARC-INS-1", amountExTax: 60000 }),
    settlement: settlement({ deliveredAmount: 60000, plannedAmount: 60000 }),
    payment: { id: 4, paymentNo: "PY-1", status: "planned", dueOn: null, note: null, amount: null, paidOn: null }
  });
  assert.deepEqual(driftOf(ok)!.flagged, []);

  const stale = delivered(60000, {
    settlementDoc: doc({ documentNo: "ARC-INS-1", amountExTax: 95000 }),
    settlement: settlement({ deliveredAmount: 60000 })
  });
  assert.deepEqual(seen(stale), [["settlementDoc", "amount", 95000, 60000]]);
  assert.equal(driftOf(stale)!.flagged[0].basisLabel, "実績");
});

// ---- 日付 -----------------------------------------------------------------

test("発注書の納品日・支払期日は、予定明細と比べる", () => {
  // 発注書の本文はここから出る（orderLinesFrom の delivery_date / payment_date）。
  const r = row({
    schedules: { total: 1, done: 0, dueOn: "2026-12-15", payOn: "2027-01-31",
                 dueVaries: false, payVaries: false },
    order: doc({ amountExTax: 95000, deliveryOn: "2026-11-30", paymentOn: "2026-12-31" })
  });
  assert.deepEqual(seen(r), [
    ["order", "delivery", "2026-11-30", "2026-12-15"],
    ["order", "payment", "2026-12-31", "2027-01-31"]
  ]);
  assert.equal(driftSummary(driftOf(r)!.flagged), "日付");
});

test("検収書の納品日・検収日は、実績と比べる", () => {
  const r = delivered(95000, {
    events: { count: 1, latestOn: "2026-09-20", latestId: 7, latestInspectedOn: "2026-09-25" },
    settlement: settlement({ deliveredAmount: 95000 }),
    settlementDoc: doc({ documentNo: "ARC-INS-1", amountExTax: 95000,
                         deliveryOn: "2026-09-01", inspectionOn: "2026-09-25" })
  });
  // 納品日だけがずれている。検収日は合っているので鳴らさない。
  assert.deepEqual(seen(r), [["settlementDoc", "delivery", "2026-09-01", "2026-09-20"]]);
});

test("支払の期日は、検収書に書いた支払期日と比べる", () => {
  const withDoc = delivered(95000, {
    settlement: settlement({ deliveredAmount: 95000, plannedAmount: 95000 }),
    settlementDoc: doc({ documentNo: "ARC-INS-1", amountExTax: 95000, paymentOn: "2026-10-31" }),
    payment: { id: 4, paymentNo: "PY-1", status: "planned", dueOn: "2026-09-30", note: null, amount: null, paidOn: null }
  });
  assert.deepEqual(seen(withDoc), [["payment", "payment", "2026-09-30", "2026-10-31"]]);
  assert.equal(driftOf(withDoc)!.flagged[0].basisLabel, "検収書");

  // 検収書が支払期日を持たなければ、予定明細の支払日と比べる。
  const withSchedule = delivered(95000, {
    schedules: { total: 1, done: 1, dueOn: null, payOn: "2026-10-31",
                 dueVaries: false, payVaries: false },
    settlement: settlement({ deliveredAmount: 95000, plannedAmount: 95000 }),
    payment: { id: 4, paymentNo: "PY-1", status: "planned", dueOn: "2026-09-30", note: null, amount: null, paidOn: null }
  });
  assert.equal(driftOf(withSchedule)!.flagged[0].basisLabel, "予定");
});

test("回ごとに日付が違う発注書は、1日とは比べない", () => {
  // 本文は「2026-10-31 〜 2026-11-30 (明細参照)」というまとめ書きになる。
  // 日付として読めないので、黙って落とさずに理由を出す。
  const r = row({
    schedules: { total: 2, done: 0, dueOn: "2026-12-15", payOn: null,
                 dueVaries: false, payVaries: false },
    order: doc({ amountExTax: 95000, deliveryOn: "2026-10-31 〜 2026-11-30 (明細参照)" })
  });
  const e = driftOf(r)!.entries.find((x) => x.field === "delivery")!;
  assert.equal(e.flagged, false);
  assert.match(e.note!, /まとめては/);
});

test("予定の日付が回ごとに違えば鳴らさない", () => {
  const r = row({
    schedules: { total: 2, done: 0, dueOn: "2026-12-15", payOn: null,
                 dueVaries: true, payVaries: false },
    order: doc({ amountExTax: 95000, deliveryOn: "2026-11-30" })
  });
  assert.equal(driftOf(r)!.entries.find((x) => x.field === "delivery")!.flagged, false);
});

test("日付の入っていない欄は比べない", () => {
  // 出していない欄を「空だからずれている」と言うと、全部の文書が鳴る。
  const r = row({ order: doc({ amountExTax: 95000 }),
                  schedules: { total: 1, done: 0, dueOn: "2026-11-30", payOn: "2026-12-31",
                               dueVaries: false, payVaries: false } });
  assert.deepEqual(driftOf(r)!.entries.filter((e) => e.field !== "amount"), []);
});

test("金額と日付が両方ずれていれば、札はそう言う", () => {
  const r = row({
    schedules: { total: 1, done: 0, dueOn: "2026-12-15", payOn: null,
                 dueVaries: false, payVaries: false },
    order: doc({ amountExTax: 120000, deliveryOn: "2026-11-30" })
  });
  assert.equal(driftSummary(driftOf(r)!.flagged), "金額と日付");
});

// ---- 分納・そろえる目標・対象外 --------------------------------------------

test("分納の途中は、食い違いではない", () => {
  const r = delivered(47500, {
    schedules: { total: 2, done: 1, dueOn: null, payOn: null, dueVaries: true, payVaries: true },
    settlementDoc: doc({ documentNo: "ARC-INS-1", amountExTax: 47500 }),
    settlement: settlement({ deliveredAmount: 47500, paidAmount: 47500 }),
    payment: { id: 4, paymentNo: "PY-1", status: "paid", dueOn: null, note: null, amount: null, paidOn: null }
  });
  assert.deepEqual(driftOf(r)!.flagged, []);
});

test("そろえる目標を返す（画面の「全部そろえる」が欄に入れる）", () => {
  const r = delivered(120000, {
    schedules: { total: 1, done: 1, dueOn: "2026-12-15", payOn: "2027-01-31",
                 dueVaries: false, payVaries: false },
    events: { count: 1, latestOn: "2026-09-20", latestId: 7, latestInspectedOn: "2026-09-25" },
    settlement: settlement({ deliveredAmount: 120000 })
  });
  assert.deepEqual(driftOf(r)!.targets, {
    amount: 95000, deliveredOn: "2026-09-20", inspectedOn: "2026-09-25",
    scheduleDueOn: "2026-12-15", schedulePayOn: "2027-01-31", paymentDueOn: "2027-01-31"
  });
});

test("総額の決まらない条件は比べない", () => {
  // 料率は「いくらであるべきか」が無い。分納・継続が前提で日付も回ごとに動く。
  const r = row({ pricingModel: "royalty", flatAmount: null, ratePpm: 50000, order: doc() });
  assert.equal(driftOf(r), null);
  assert.equal(hasDrift(r), false);
});

test("払い切ったあとでも鳴らす", () => {
  const r = row({
    settlement: settlement({ state: "paid", done: true, paidAmount: 95000 }), order: doc()
  });
  assert.equal(hasDrift(r), true);
});

test("段と欄の名前が全部ある（画面の見出しに使う）", () => {
  for (const key of ["order", "settlementDoc", "event", "payment"] as const) {
    assert.ok(DRIFT_LABEL[key], `${key} の名前が無い`);
  }
  for (const key of ["amount", "delivery", "inspection", "payment"] as const) {
    assert.ok(FIELD_LABEL[key], `${key} の名前が無い`);
  }
});

test("同じ条件に発注書が何枚もあれば、金額は比べない（日付は比べる）", () => {
  // 追加発注・分割発注では、1枚の総額が条件の総額と合わなくて当たり前。
  // 日付は足し算ではないので、いちばん新しい1枚と比べてよい。
  const r = row({
    schedules: { total: 1, done: 0, dueOn: "2026-12-15", payOn: null,
                 dueVaries: false, payVaries: false },
    order: doc({ siblingCount: 4, amountExTax: 135000, deliveryOn: "2026-11-30" })
  });
  const d = driftOf(r)!;
  const amount = d.entries.find((e) => e.field === "amount")!;
  assert.equal(amount.flagged, false);
  assert.match(amount.note!, /発注書が 4 枚/);
  assert.deepEqual(d.flagged.map((e) => e.field), ["delivery"]);
});

test("直し方は、機械がやるぶんと人が押すぶんに分かれる", () => {
  const r = row({
    schedules: { total: 1, done: 0, dueOn: "2026-12-15", payOn: null,
                 dueVaries: false, payVaries: false },
    order: doc({ id: 41, documentNo: "ARC-PO-1", amountExTax: 120000, deliveryOn: "2026-11-30" })
  });
  const plan = repairPlan(r, driftOf(r)!);
  assert.deepEqual(plan.steps.map((s) => s.kind), ["auto", "hand"]);
  assert.match(plan.steps[0].text, /訂正版を下書きで作る/);
  assert.match(plan.steps[1].text, /訂正版を決定する/);
  // 決定は文書の画面へ渡す。
  assert.deepEqual(plan.steps[1].go, { what: "document", id: 41 });
  assert.deepEqual(plan.reissue, [{ part: "order", id: 41, documentNo: "ARC-PO-1" }]);
});

test("支払の金額は人に渡す（割当の合計なのでここでは直せない）", () => {
  const r = delivered(60000, {
    settlement: settlement({ deliveredAmount: 60000, plannedAmount: 95000 }),
    payment: { id: 4, paymentNo: "PY-1", status: "planned", dueOn: null, note: null, amount: null, paidOn: null }
  });
  const plan = repairPlan(r, driftOf(r)!);
  assert.deepEqual(plan.steps.map((s) => s.kind), ["hand"]);
  assert.match(plan.steps[0].text, /割当/);
  assert.deepEqual(plan.steps[0].go, { what: "payment", id: 4 });
  assert.deepEqual(plan.reissue, []);
});

test("支払の期日は保存で直せる（人は要らない）", () => {
  const r = delivered(95000, {
    settlement: settlement({ deliveredAmount: 95000, plannedAmount: 95000 }),
    settlementDoc: doc({ documentNo: "ARC-INS-1", amountExTax: 95000, paymentOn: "2026-10-31" }),
    payment: { id: 4, paymentNo: "PY-1", status: "planned", dueOn: "2026-09-30", note: null, amount: null, paidOn: null }
  });
  const plan = repairPlan(r, driftOf(r)!);
  assert.deepEqual(plan.steps.map((s) => s.kind), ["auto"]);
  assert.equal(plan.paymentDueOn, "2026-10-31");
  assert.match(plan.steps[0].text, /期日を 2026-10-31 に/);
});

test("食い違いが無ければ手順も無い", () => {
  const r = row({ order: doc({ amountExTax: 95000 }) });
  assert.deepEqual(repairPlan(r, driftOf(r)!), { steps: [], reissue: [], paymentDueOn: null });
});

test("訂正版の下書きがもうあれば、作り直さず「決定する」に変える", () => {
  // もう一度作ろうとするとサーバが断る。断られる手順を画面に出さない。
  const r = row({ order: doc({ id: 41, documentNo: "ARC-PO-1" }) });
  const plan = repairPlan(r, driftOf(r)!, new Map([[41, 105]]));
  assert.deepEqual(plan.reissue, [], "作り直しには渡さない");
  assert.deepEqual(plan.steps.map((s) => s.kind), ["hand"]);
  assert.match(plan.steps[0].text, /もう下書き #105 にあります/);
  // 押す先は下書きのほう（元の文書を開いても決定できない）。
  assert.deepEqual(plan.steps[0].go, { what: "document", id: 105 });
});
