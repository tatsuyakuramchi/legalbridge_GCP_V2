import test from "node:test";
import assert from "node:assert/strict";
import { buildPayDocRows, countTiles, isTodo, type BuildInput, type PdCondition } from "./rows.js";
import { receiptOf, receiptRuleFor } from "../documents/delivery.js";

const cond = (over: Partial<PdCondition> = {}): PdCondition => ({
  id: 1, conditionNo: "CL-1", name: "紙書籍 印税", kind: "license", pricingModel: "revenue_rate",
  usageType: "pub_digital", direction: "in", timeSettlement: false, statementTiming: null, settlementMode: "term_bound",
  reportDueDays: null, party: { id: 7, name: "如月 涼" }, work: { id: 3, title: "星降る街の図書館" }, ...over
});
const base = (over: Partial<BuildInput> = {}): BuildInput => ({
  conditions: [cond()], schedules: [], events: [], documents: [], drafts: [], allocations: [], plans: [], skips: [],
  today: "2026-10-16", ...over
});
const sched = (id: number, dueOn: string, over = {}) => ({
  id, conditionId: 1, seq: id, label: null, dueOn, payOn: null, plannedAmount: 0, triggerKind: "periodic", ...over
});
const ev = (id: number, occurredOn: string, over = {}) => ({
  id, conditionId: 1, scheduleId: null, eventType: "sales", occurredOn, amount: 1000, documentId: null,
  reportReceivedOn: null, quantity: null, period: null, ...over
});
const doc = (id: number, over = {}) => ({
  id, documentNo: `ROY-${id}`, status: "issued", templateKey: "royalty_statement", issuedOn: "2026-10-01",
  sentAt: null, sentVia: null, receivedAt: null, receivedVia: null, past: false, inbound: false, needsSignature: false, ...over
});

test("受動：締めを過ぎて報告が無い回は報告待ち。報告期限（既定 30 日）を過ぎたら督促", () => {
  const rows = buildPayDocRows(base({ schedules: [sched(1, "2026-06-30"), sched(2, "2026-09-30"), sched(3, "2026-12-31")] }));
  const [jun, sep, dec] = rows;
  assert.equal(jun.trigger, "passive");
  assert.equal(jun.source.state, "late", "6/30 締め＋30 日を過ぎた");
  assert.equal(jun.source.reportDueOn, "2026-07-30");
  assert.equal(jun.next, "remind_report");
  assert.equal(jun.overdue, true);
  assert.equal(sep.source.state, "waiting", "9/30 締め＋30 日＝10/30 はまだ");
  assert.equal(sep.source.label, "報告待ち");
  assert.equal(dec.source.state, "before");
  assert.equal(dec.next, "none");
  const longer = buildPayDocRows(base({ conditions: [cond({ reportDueDays: 120 })], schedules: [sched(1, "2026-06-30")] }));
  assert.equal(longer[0].source.state, "waiting", "条件ごとの報告期限");
});

test("文書は全部の実績が決定した文書に載って済。1 件でも残れば作れる（一部）", () => {
  const rows = buildPayDocRows(base({
    schedules: [sched(1, "2026-09-30")],
    events: [ev(10, "2026-09-10", { documentId: 100 }), ev(11, "2026-09-20")],
    documents: [doc(100)]
  }));
  assert.equal(rows[0].doc.state, "make");
  assert.equal(rows[0].doc.partial, true);
  assert.equal(rows[0].next, "compose");
  const done = buildPayDocRows(base({
    schedules: [sched(1, "2026-09-30")],
    events: [ev(10, "2026-09-10", { documentId: 100 }), ev(11, "2026-09-20", { documentId: 100 })],
    documents: [doc(100)]
  }));
  assert.equal(done[0].doc.state, "done");
  assert.equal(done[0].send.state, "unsent");
  assert.equal(done[0].next, "send");
});

test("下書きは決定していない。実績を持つ下書きがあれば「下書き」", () => {
  const rows = buildPayDocRows(base({
    schedules: [sched(1, "2026-09-30")], events: [ev(10, "2026-09-10", { documentId: 200 })],
    documents: [doc(200, { status: "draft" })], drafts: [{ id: 200, eventIds: [10] }]
  }));
  assert.equal(rows[0].doc.state, "draft");
  assert.equal(rows[0].next, "finish_draft");
});

test("能動：刷ごと（イベント式）は製造の実績 1 日が 1 回。製造予定は記録待ちの行", () => {
  const c = cond({ usageType: "pub_print", settlementMode: null, pricingModel: "unit_rate" });
  const rows = buildPayDocRows(base({
    conditions: [c],
    events: [ev(20, "2026-10-05", { eventType: "manufacturing", quantity: 3000 }),
             ev(21, "2026-10-05", { eventType: "manufacturing", quantity: 2000 })],
    plans: [{ id: 5, conditionId: 1, plannedOn: "2026-11-05", quantity: 3000, label: null, source: "manual", sourceDocumentNo: null }]
  }));
  assert.equal(rows.length, 2);
  const made = rows.find((r) => r.key.startsWith("e:"))!;
  assert.equal(made.trigger, "active");
  assert.equal(made.eventIds.length, 2, "同じ日の製造は 1 回にまとめる");
  assert.match(made.source.label, /製造 10\/5/);
  assert.match(made.source.detail ?? "", /5,000 部/);
  assert.equal(made.next, "compose");
  const plan = rows.find((r) => r.key === "p:5")!;
  assert.equal(plan.trigger, "active");
  assert.equal(plan.source.state, "plan");
  assert.equal(plan.next, "record_event");
  assert.equal(countTiles(rows).wait, 1);
});

test("能動：納品の回（on_delivery）は納品待ち。報告期限は付かない", () => {
  const c = cond({ kind: "service", pricingModel: "fixed", usageType: null, name: "イラスト制作" });
  const rows = buildPayDocRows(base({ conditions: [c], schedules: [sched(1, "2026-08-31", { triggerKind: "on_delivery" })] }));
  assert.equal(rows[0].trigger, "active");
  assert.equal(rows[0].source.label, "納品待ち");
  assert.equal(rows[0].source.reportDueOn, null);
  assert.equal(rows[0].templateKey, "inspection_certificate");
});

test("送付・受領・支払：署名欄のある検収書は署名返送待ち、10 営業日を過ぎたら期限超過", () => {
  const c = cond({ kind: "service", pricingModel: "fixed", usageType: null });
  const input = (sentAt: string | null, receivedAt: string | null = null) => base({
    conditions: [c], schedules: [sched(1, "2026-08-31", { triggerKind: "on_delivery" })],
    events: [ev(10, "2026-08-31", { eventType: "delivery", documentId: 100, scheduleId: 1 })],
    documents: [doc(100, { templateKey: "inspection_certificate", needsSignature: true, sentAt, sentVia: "gmail", receivedAt,
                            receivedVia: receivedAt ? "signed_copy" : null })]
  });
  const recent = buildPayDocRows(input("2026-10-08T01:00:00Z"))[0];
  assert.equal(recent.send.state, "sent");
  assert.equal(recent.receipt.state, "await");
  assert.equal(recent.next, "pay", "支払が先（受領待ちは並行）");
  const old = buildPayDocRows(input("2026-09-04T01:00:00Z"))[0];
  assert.equal(old.receipt.state, "late");
  assert.equal(old.overdue, true);
  assert.equal(old.next, "remind_receipt");
  const got = buildPayDocRows(input("2026-09-04T01:00:00Z", "2026-09-10T03:00:00Z"))[0];
  assert.equal(got.receipt.state, "received");
  assert.equal(got.receipt.via, "signed_copy");
});

test("役務提供完了通知書は確認期限を過ぎたら確認とみなす。計算書は受領を追わない", () => {
  assert.equal(receiptRuleFor("service_completion_notice", {}), "deemed");
  assert.equal(receiptRuleFor("service_completion_notice", { needsSignature: true }), "signature");
  assert.equal(receiptRuleFor("royalty_statement", { needsSignature: true }), "none");
  assert.equal(receiptRuleFor("inspection_certificate", {}), "none");
  const deemed = receiptOf({ rule: "deemed", sentOn: "2026-10-02", receivedOn: null, receivedVia: null, today: "2026-10-20" });
  assert.equal(deemed.state, "received");
  assert.equal(deemed.via, "deemed");
  assert.equal(deemed.dueOn, "2026-10-19", "10/2 から 10 営業日（10/12 スポーツの日を除く）");
  const waiting = receiptOf({ rule: "deemed", sentOn: "2026-10-02", receivedOn: null, receivedVia: null, today: "2026-10-16" });
  assert.equal(waiting.state, "await");
});

test("過去分・相手から受け取った文書・支払の状態", () => {
  const rows = buildPayDocRows(base({
    schedules: [sched(1, "2025-12-31"), sched(2, "2026-06-30")],
    events: [ev(10, "2025-12-31", { documentId: 100, scheduleId: 1 }), ev(11, "2026-06-30", { documentId: 101, scheduleId: 2 })],
    documents: [doc(100, { sentAt: "2026-01-10T00:00:00Z", sentVia: "past", past: true }),
                doc(101, { inbound: true })],
    allocations: [{ eventId: 10, paymentId: 9, paymentNo: "PAY-9", status: "paid", dueOn: "2026-02-28", paidOn: "2026-02-27" }]
  }));
  assert.equal(rows[0].past, true);
  assert.equal(rows[0].send.state, "past");
  assert.equal(rows[0].payment.state, "paid");
  assert.equal(isTodo(rows[0]), false, "過去分は要対応に出さない");
  assert.equal(rows[1].send.state, "na", "受け取った文書は送付を追わない");
  assert.equal(rows[1].payment.state, "unset");
  assert.equal(rows[1].next, "pay");
});

test("今期は無しにした回は要対応に出さない。金額 0 で済んだ回は支払なし", () => {
  const rows = buildPayDocRows(base({
    schedules: [sched(1, "2026-03-31"), sched(2, "2026-06-30")],
    skips: [{ conditionId: 1, scheduleId: 1 }],
    events: [ev(11, "2026-06-30", { scheduleId: 2, amount: 0, documentId: 101 })],
    documents: [doc(101, { sentAt: "2026-07-10T00:00:00Z", sentVia: "gmail" })]
  }));
  assert.equal(rows[0].source.state, "skipped");
  assert.equal(isTodo(rows[0]), false);
  assert.equal(rows[1].payment.state, "nopay");
  assert.equal(rows[1].next, "none");
});

test("締め日の無い回（いつでも）：回に結び付けずに入れた実績はその回に当たる。1 回きりの仕事が 2 行に割れない", () => {
  const c = cond({ id: 1, kind: "service", pricingModel: "fixed", usageType: null, name: "イベント運営", settlementMode: "count" });
  const rows = buildPayDocRows(base({
    conditions: [c],
    schedules: [sched(1, null as unknown as string, { triggerKind: "on_delivery", plannedAmount: 13500 })],
    events: [ev(1, "2026-10-21", { eventType: "delivery", amount: 13500 })]
  }));
  assert.equal(rows.length, 1, "回の行だけ（実績の行が別に生えない）");
  assert.equal(rows[0].scheduleId, 1);
  assert.deepEqual(rows[0].eventIds, [1]);
  // 回に結び付けた実績があれば、結び付けていない別の実績は別の行のまま（混ぜない）。
  const rows2 = buildPayDocRows(base({
    conditions: [c],
    schedules: [sched(1, null as unknown as string, { triggerKind: "on_delivery", plannedAmount: 13500 })],
    events: [ev(1, "2026-10-21", { eventType: "delivery", amount: 13500, scheduleId: 1 }), ev(2, "2026-10-22", { eventType: "delivery", amount: 500 })]
  }));
  assert.equal(rows2.length, 2);
  assert.deepEqual(rows2[0].eventIds, [1]);
});
