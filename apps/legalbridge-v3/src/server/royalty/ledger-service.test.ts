import test from "node:test";
import assert from "node:assert/strict";
import { buildRounds, settleRound, timingOf, type LedgerCondition, type LedgerEvent, type Round } from "./ledger-service.js";

const cond = (id: number, over: Partial<LedgerCondition> = {}): LedgerCondition => ({
  id, conditionNo: null, name: `c${id}`, usageType: "in_house", usageLabel: "", workId: 1, workTitle: "ito",
  agreementId: null, agreementNo: null, pricingModel: "revenue_rate", ratePpm: 80000, unitAmount: null,
  mgAmount: null, agAmount: null, currency: "JPY", paymentTerms: "締め月の翌月末払い",
  timing: "periodic", timingExplicit: false, schedules: 0, ...over
});
const ev = (id: number, conditionId: number, on: string, over: Partial<LedgerEvent> = {}): LedgerEvent => ({
  id, conditionId, scheduleId: null, eventType: "sales", occurredOn: on, period: null, usageType: "in_house",
  outConditionId: null, outName: null, workId: null, workTitle: null, quantity: null, unitAmount: null,
  grossAmount: 100, amount: 100, documentId: null, ...over
});
const Q = (conditionId: number, base = 0) => [
  { id: base + 1, conditionId, seq: 1, dueOn: "2026-06-30", payOn: "2026-07-31", label: "4〜6月" },
  { id: base + 2, conditionId, seq: 2, dueOn: "2026-09-30", payOn: "2026-10-31", label: "7〜9月" }
];

test("出し方の既定は、紙出版がイベント式、それ以外は時限式。明示があればそれ", () => {
  assert.equal(timingOf(null, "pub_print"), "event");
  assert.equal(timingOf(null, "in_house"), "periodic");
  assert.equal(timingOf("event", "in_house"), "event");
});

test("締めがずれた契約も、支払日が同じなら1つの回にまとまる（作家でまとめる）", () => {
  const rounds = buildRounds({
    conditions: [cond(1), cond(2, { workId: 2 })],
    schedules: [...Q(1), { id: 9, conditionId: 2, seq: 1, dueOn: "2026-08-31", payOn: "2026-10-31", label: "6〜8月" }],
    events: [ev(1, 1, "2026-09-10"), ev(2, 2, "2026-08-20")], skips: [], outs: [],
    bundle: "per_party", today: "2026-10-05"
  });
  const oct = rounds.find((r) => r.payOn === "2026-10-31")!;
  assert.deepEqual(oct.parts.map((p) => p.conditionId).sort(), [1, 2]);
  assert.deepEqual(oct.workIds.sort(), [1, 2]);
  // 作品ごとなら別の回
  const per = buildRounds({
    conditions: [cond(1), cond(2, { workId: 2 })],
    schedules: [...Q(1), { id: 9, conditionId: 2, seq: 1, dueOn: "2026-08-31", payOn: "2026-10-31", label: "6〜8月" }],
    events: [ev(1, 1, "2026-09-10"), ev(2, 2, "2026-08-20")], skips: [], outs: [],
    bundle: "per_work", today: "2026-10-05"
  });
  assert.equal(per.filter((r) => r.payOn === "2026-10-31").length, 2);
});

test("イベント式は実績1件が1回。支払日は支払条件から", () => {
  const rounds = buildRounds({
    conditions: [cond(1, { timing: "event", usageType: "pub_print" })], schedules: [],
    events: [ev(5, 1, "2026-08-20", { eventType: "manufacturing" })], skips: [], outs: [],
    bundle: "per_party", today: "2026-10-05"
  });
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].kind, "event");
  assert.equal(rounds[0].payOn, "2026-09-30");
});

test("来るはずの行：前の回にあった許諾先と、生きている許諾先", () => {
  const rounds = buildRounds({
    conditions: [cond(1, { usageType: "sublicense" })], schedules: Q(1),
    events: [ev(1, 1, "2026-06-10", { usageType: "sublicense", outConditionId: 50, outName: "Alpha" })],
    skips: [], outs: [{ id: 60, name: "Beta", usageType: "sublicense", workId: 1, termStart: "2026-07-01" }],
    bundle: "single_work", today: "2026-10-05"
  });
  const q3 = rounds.find((r) => r.payOn === "2026-10-31")!;
  assert.deepEqual(q3.parts[0].expected.map((x) => x.outName).sort(), ["Alpha", "Beta"]);
  assert.equal(q3.state, "input");
  const q2 = rounds.find((r) => r.payOn === "2026-07-31")!;
  assert.deepEqual(q2.parts[0].expected.map((x) => x.outName), [], "Beta は 7月から");
});

test("空のまま過ぎた回は、人が報告なしにするまで報告待ち。締め前は before", () => {
  const rounds = buildRounds({
    conditions: [cond(1)], schedules: [...Q(1), { id: 3, conditionId: 1, seq: 3, dueOn: "2026-12-31", payOn: "2027-01-31", label: "10〜12月" }],
    events: [ev(1, 1, "2026-09-10")], skips: [], outs: [], bundle: "single_work", today: "2026-12-01"
  });
  assert.equal(rounds.find((r) => r.payOn === "2026-07-31")!.state, "input", "あとの回に実績があっても自動では閉じない");
  assert.equal(rounds.find((r) => r.payOn === "2026-07-31")!.parts[0].state, "waiting");
  assert.equal(rounds.find((r) => r.payOn === "2027-01-31")!.state, "before");
  const skipped = buildRounds({
    conditions: [cond(1)], schedules: Q(1), events: [], skips: [{ conditionId: 1, scheduleId: 2 }], outs: [],
    bundle: "single_work", today: "2026-10-05"
  });
  assert.equal(skipped.find((r) => r.payOn === "2026-10-31")!.state, "skipped");
  assert.equal(skipped.find((r) => r.payOn === "2026-07-31")!.state, "input", "報告待ち");
});

test("決まった回は、支払・送付・AG 充当だけ（支払なし）で閉じる", () => {
  const base: Round = { key: "p", kind: "period", payOn: null, closeOn: null, workIds: [], parts: [],
    documents: [{ id: 1, documentNo: "RS-1", status: "issued", sent: false, net: 100 }], payments: [],
    requests: [], state: "issued", open: true };
  assert.equal(settleRound(base).state, "issued");
  assert.equal(settleRound({ ...base, documents: [{ ...base.documents[0], sent: true }] }).state, "sent");
  assert.equal(settleRound({ ...base, documents: [{ ...base.documents[0], net: 0 }] }).open, false);
  const pay = { id: 1, paymentNo: null, status: "planned", amount: 1, dueOn: "2026-10-31", paidOn: null };
  assert.equal(settleRound({ ...base, payments: [pay] }).state, "scheduled");
  const paid = settleRound({ ...base, payments: [{ ...pay, status: "paid" }] });
  assert.equal(paid.state, "paid"); assert.equal(paid.open, false);
});
