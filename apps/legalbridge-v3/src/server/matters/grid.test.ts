import test from "node:test";
import assert from "node:assert/strict";
import { GRID_FILTER_LABEL, applyFilter, filterCounts, groupByParty, groupByWork, isPending, isStuck, unpaidPayments } from "./grid.js";
import type { GridRound } from "./grid.js";
import type { GridRow } from "./grid.js";

const settlement = (over: Partial<GridRow["settlement"]> = {}): GridRow["settlement"] => ({
  state: "open", done: false, eventCount: 0, deliveredAmount: 0, plannedAmount: 0,
  paidAmount: 0, targetAmount: 100000, closedAt: null, closedReason: null, ...over
});

const row = (over: Partial<GridRow> = {}): GridRow => ({
  conditionId: 1, conditionNo: "CL-1", name: "挿絵 5点", kind: "service",
  counterparty: { id: 10, name: "みなも工房" },
  pricingModel: "fixed", currency: "JPY", flatAmount: 100000, unitAmount: null, ratePpm: null,
  status: "active", settlement: settlement(), workId: null, deliverableOwnership: null, licenseCount: 0,
  schedules: { total: 0, done: 0, dueOn: null, payOn: null, dueVaries: false, payVaries: false },
  order: null, events: { count: 0, latestOn: null, latestId: null, latestInspectedOn: null }, settlementDoc: null, payment: null,
  ...over
});

test("段ごとの「まだ」の判定", () => {
  const bare = row();
  assert.equal(isPending(bare, "order"), true);
  assert.equal(isPending(bare, "event"), true);
  assert.equal(isPending(bare, "settlementDoc"), true);
  assert.equal(isPending(bare, "payment"), true);

  // 下書きの発注書も「ある」。作り直すのは訂正版の話で、この画面の仕事ではない。
  const drafted = row({ order: { id: 5, documentNo: null, phase: "draft", amountExTax: null, conditionCount: 1, siblingCount: 1, deliveryOn: null, inspectionOn: null, paymentOn: null, sign: { status: "unsent", at: null, source: null } } });
  assert.equal(isPending(drafted, "order"), false);

  // 予定は、回があって全部消化していれば済み。
  assert.equal(isPending(row({ schedules: { total: 2, done: 2, dueOn: null, payOn: null, dueVaries: false, payVaries: false } }), "schedule"), false);
  assert.equal(isPending(row({ schedules: { total: 2, done: 1, dueOn: null, payOn: null, dueVaries: false, payVaries: false } }), "schedule"), true);
  assert.equal(isPending(row({ schedules: { total: 0, done: 0, dueOn: null, payOn: null, dueVaries: false, payVaries: false } }), "schedule"), true);
});

test("払い切った条件は、段が空でも「まだ」に数えない", () => {
  // 完了扱いにした古い条件は、文書も支払も V3 に無い。これを「発注書がまだ」に
  // 数えると、もう作らないものが毎回上がってくる。
  const done = row({ settlement: settlement({ state: "paid", done: true }) });
  assert.deepEqual(applyFilter([done], "order"), []);
  assert.deepEqual(applyFilter([done], "payment"), []);
  assert.deepEqual(applyFilter([done], "settled"), [done]);
});

test("段で絞ると、その段が空の行だけが残る", () => {
  const rows = [
    row({ conditionId: 1, order: { id: 1, documentNo: "PO-1", phase: "decided", amountExTax: null, conditionCount: 1, siblingCount: 1, deliveryOn: null, inspectionOn: null, paymentOn: null, sign: { status: "unsent", at: null, source: null } } }),
    row({ conditionId: 2 }),
    row({ conditionId: 3, order: { id: 3, documentNo: "PO-3", phase: "draft", amountExTax: null, conditionCount: 1, siblingCount: 1, deliveryOn: null, inspectionOn: null, paymentOn: null, sign: { status: "unsent", at: null, source: null } },
          events: { count: 2, latestOn: "2026-09-01", latestId: 77, latestInspectedOn: "2026-09-01" } })
  ];
  assert.deepEqual(applyFilter(rows, "order").map((r) => r.conditionId), [2]);
  assert.deepEqual(applyFilter(rows, "event").map((r) => r.conditionId), [1, 2]);
  assert.deepEqual(applyFilter(rows, "all").length, 3);
});

test("札の件数は、押す前にどこに何件あるかを出す", () => {
  const rows = [
    row({ conditionId: 1, settlement: settlement({ state: "paid", done: true }) }),
    row({ conditionId: 2, order: { id: 2, documentNo: "PO-2", phase: "decided", amountExTax: null, conditionCount: 1, siblingCount: 1, deliveryOn: null, inspectionOn: null, paymentOn: null, sign: { status: "unsent", at: null, source: null } } }),
    row({ conditionId: 3 })
  ];
  const counts = filterCounts(rows);
  assert.equal(counts.all, 3);
  assert.equal(counts.settled, 1);
  assert.equal(counts.order, 1, "発注書がまだ＝条件3だけ（1は払い切り、2はある）");
  assert.equal(counts.payment, 2);
  // 札の名前が全部ある（片方だけ足して画面が空になるのを防ぐ）。
  for (const key of Object.keys(counts)) {
    assert.ok(GRID_FILTER_LABEL[key as keyof typeof GRID_FILTER_LABEL], `${key} の名前が無い`);
  }
});

test("取引先でまとめると、社ごとの小計が付く", () => {
  const rows = [
    row({ conditionId: 1, counterparty: { id: 10, name: "みなも工房" },
          order: { id: 1, documentNo: "PO-1", phase: "decided", amountExTax: null, conditionCount: 1, siblingCount: 1, deliveryOn: null, inspectionOn: null, paymentOn: null, sign: { status: "unsent", at: null, source: null } },
          payment: { id: 1, paymentNo: "PY-1", status: "paid", dueOn: null, note: null, amount: null, paidOn: null } }),
    row({ conditionId: 2, counterparty: { id: 20, name: "夜半堂" } }),
    row({ conditionId: 3, counterparty: { id: 10, name: "みなも工房" } }),
    row({ conditionId: 4, counterparty: null })
  ];
  const groups = groupByParty(rows);
  assert.deepEqual(groups.map((g) => g.name), ["みなも工房", "夜半堂", "（相手先なし）"]);
  assert.deepEqual(groups[0].tally, { conditions: 2, orders: 1, settlementDocs: 0, payments: 1 });
  assert.deepEqual(groups[0].rows.map((r) => r.conditionId), [1, 3]);
  // 相手先の分からない行も落とさない（消えると数が合わなくなる）。
  assert.equal(groups[2].rows.length, 1);
});

const round = (over: Partial<GridRound> = {}): GridRound => ({
  scheduleId: null, seq: null, label: null, plannedAmount: null, dueOn: null,
  eventId: null, occurredOn: null, inspectedOn: null, quantity: null, amount: null, doc: null, payment: null, ...over
});
const pay = (id: number, status: string) => ({ id, paymentNo: `PY-${id}`, status, amount: 1000, dueOn: null, paidOn: null, note: null });

test("作品でまとめる：止まり・未払いを数え、作品なしは最後", () => {
  const rows = [
    row({ conditionId: 1, workId: 7, workTitle: "作品A", rounds: [round({ eventId: 11, doc: { id: 1, documentNo: "IC-1", status: "issued", phase: "決定済み" }, payment: pay(41, "paid") }), round({ eventId: 12, doc: null })] }),
    row({ conditionId: 2, workId: null }),
    row({ conditionId: 3, workId: 7, workTitle: "作品A", payment: { id: 42, paymentNo: "PY-42", status: "planned", dueOn: null, note: null, amount: 1000, paidOn: null } })
  ];
  const groups = groupByWork(rows);
  assert.deepEqual(groups.map((g) => g.title), ["作品A", "（作品なし）"]);
  // 第2回の検収書がまだ → 止まり。第1回は支払済みなので未払いに数えない。
  assert.deepEqual(groups[0].tally, { conditions: 2, stuck: 2, unpaid: 1, amount: 200000 });
});

test("未払いの支払は回ごとに拾い、同じ支払は1回だけ", () => {
  const shared = pay(50, "approved");
  const r = row({ rounds: [round({ eventId: 1, payment: shared }), round({ eventId: 2, payment: shared }), round({ eventId: 3, payment: pay(51, "paid") })] });
  assert.deepEqual(unpaidPayments(r).map((p) => p.id), [50]);
  // 回の情報が無ければ行の支払。
  assert.deepEqual(unpaidPayments(row({ payment: { id: 9, paymentNo: null, status: "planned", dueOn: null, note: null, amount: null, paidOn: null } })).map((p) => p.id), [9]);
  assert.equal(isStuck(row({ settlement: settlement({ done: true }) })), false);
});
