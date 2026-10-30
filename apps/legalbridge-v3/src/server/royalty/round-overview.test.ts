import test from "node:test";
import assert from "node:assert/strict";
import { buildRounds, numberStatements, outCoversWork, type LedgerCondition, type LedgerEvent, type LedgerView, type Round } from "./ledger-service.js";
import { crossRounds, overviewRows } from "./round-overview.js";

const cond = (id: number, over: Partial<LedgerCondition> = {}): LedgerCondition => ({
  id, conditionNo: `CL-${id}`, name: `c${id}`, usageType: "in_house", usageLabel: "自社製造・自社販売", workId: 1, workTitle: "ito",
  agreementId: null, agreementNo: null, pricingModel: "revenue_rate", ratePpm: 80000, unitAmount: null,
  mgAmount: null, agAmount: null, currency: "JPY", paymentTerms: "締め月の翌月末払い",
  timing: "periodic", timingExplicit: false, schedules: 0, ...over
});
const ev = (id: number, conditionId: number, on: string, over: Partial<LedgerEvent> = {}): LedgerEvent => ({
  id, conditionId, scheduleId: null, eventType: "sales", occurredOn: on, period: null, usageType: "in_house",
  outConditionId: null, outName: null, workId: null, workTitle: null, quantity: null, unitAmount: null,
  grossAmount: 100, amount: 100, documentId: null, ...over
});

test("回号：時限式は締めの seq、イベント式はその条件の製造日の順、予定の外は数えない", () => {
  const rounds = buildRounds({
    conditions: [cond(1), cond(2, { timing: "event", usageType: "oem" })],
    schedules: [
      { id: 11, conditionId: 1, seq: 3, dueOn: "2026-06-30", payOn: "2026-07-31", label: "4〜6月" },
      { id: 12, conditionId: 1, seq: 4, dueOn: "2026-09-30", payOn: "2026-10-31", label: "7〜9月" }
    ],
    events: [
      ev(1, 1, "2026-05-10"), ev(2, 1, "2026-12-20"),
      // イベント式：同じ製造日の報告は 1 回。入れた順ではなく日付の順に数える。
      ev(3, 2, "2026-09-01", { eventType: "manufacturing", usageType: "oem" }),
      ev(4, 2, "2026-03-01", { eventType: "manufacturing", usageType: "oem" }),
      ev(5, 2, "2026-09-01", { eventType: "manufacturing", usageType: "oem" })
    ],
    skips: [], outs: [], bundle: "single_work", today: "2026-10-05", lookaheadDays: 400
  });
  const parts = rounds.flatMap((r) => r.parts);
  const of = (c: number) => parts.filter((p) => p.conditionId === c).map((p) => [p.closeOn, p.roundNo ?? null])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  assert.deepEqual(of(1), [["2026-06-30", 3], ["2026-09-30", 4], ["2026-12-20", null]]);
  assert.deepEqual(of(2), [["2026-03-01", 1], ["2026-09-01", 2]]);
});

const round = (key: string, workIds: number[], docs: Array<[number, string]>): Round => ({
  key, kind: "period", usageType: null, payOn: null, closeOn: null, workIds, parts: [],
  documents: docs.map(([id, on]) => ({ id, documentNo: `RS-${id}`, status: "issued", sent: false, net: 1, paymentIds: [], issuedOn: on })),
  payments: [], requests: [], state: "issued", open: false
});

test("計算書の通し番号：作家 × 作品ごとに決定日の順。作品をまたいだ計算書は作家の通し", () => {
  const rounds = [
    round("a", [1], [[30, "2026-09-01"]]),
    round("b", [1], [[10, "2026-03-01"], [20, "2026-03-01"]]),
    round("c", [2], [[40, "2026-01-01"]]),
    round("d", [1, 2], [[50, "2026-05-01"]])
  ];
  numberStatements(rounds);
  const seq = (id: number) => rounds.flatMap((r) => r.documents).find((d) => d.id === id)!.seq;
  assert.deepEqual([seq(10), seq(20), seq(30)], [1, 2, 3], "同じ日は文書 id の順");
  assert.equal(seq(40), 1, "作品 2 は別に数える");
  assert.equal(seq(50), 1, "まとめた計算書は作家の通し");
});

test("回と文書：条件の行に回号・状態・その回の計算書と許諾先が並ぶ", () => {
  const built = buildRounds({
    conditions: [cond(1, { usageType: "sublicense", usageLabel: "再許諾" })],
    schedules: [{ id: 11, conditionId: 1, seq: 1, dueOn: "2026-06-30", payOn: "2026-07-31", label: "4〜6月" }],
    events: [ev(1, 1, "2026-05-10", { usageType: "sublicense", outConditionId: 70, outName: "Asmodee｜英語", documentId: 900 }),
             ev(2, 1, "2026-05-20", { usageType: "sublicense", outConditionId: 70, outName: "Asmodee｜英語", documentId: 900 })],
    skips: [], outs: [], bundle: "single_work", today: "2026-10-05"
  });
  built[0].documents = [{ id: 900, documentNo: "RS-900", status: "issued", sent: true, net: 5, paymentIds: [], issuedOn: "2026-07-10", seq: 1 }];
  const view: LedgerView = {
    party: { id: 5, name: "作家A", kind: "individual", residency: "resident", bundle: "per_work", bundleExplicit: false, mixModels: false },
    scope: { workId: 1, workTitle: "ito" }, works: [{ id: 1, title: "ito", conditions: 1 }],
    conditions: [cond(1, { usageType: "sublicense", usageLabel: "再許諾" })], schedules: [],
    rounds: [], history: built, requests: []
  };
  const [row] = overviewRows(view);
  assert.equal(row.partyName, "作家A");
  assert.equal(row.cells.length, 1);
  assert.equal(row.cells[0].roundNo, 1);
  assert.equal(row.cells[0].reports, 2);
  assert.deepEqual(row.cells[0].documents.map((d) => [d.documentNo, d.seq]), [["RS-900", 1]]);
  assert.deepEqual(row.outs, [{ id: 70, name: "Asmodee｜英語", agreementNo: null, reports: 2 }]);
  const [x] = crossRounds(view);
  assert.equal(x.key, `5:${built[0].key}`);
  assert.deepEqual(x.conditions.map((c) => c.roundNo), [1]);
});

test("派生作品（言語版など）の許諾先も、元の作品の IN 条件（作者）に来るはずの行として出る", () => {
  const rounds = buildRounds({
    conditions: [cond(1, { usageType: "sublicense", workId: 1 }), cond(2, { usageType: "sublicense", workId: 1 })],
    schedules: [
      { id: 11, conditionId: 1, seq: 1, dueOn: "2026-09-30", payOn: "2026-10-31", label: "7〜9月" },
      { id: 21, conditionId: 2, seq: 1, dueOn: "2026-09-30", payOn: "2026-10-31", label: "7〜9月" }
    ],
    events: [], skips: [],
    outs: [
      // 作品 2 は作品 1 の派生（英語版）。
      { id: 70, name: "Asmodee｜英語版", usageType: "sublicense", workId: 2, termStart: null, lineageWorkIds: [2, 1] },
      // 関係の無い作品の許諾は出ない。
      { id: 71, name: "別作品", usageType: "sublicense", workId: 3, termStart: null, lineageWorkIds: [3] }
    ],
    bundle: "single_work", today: "2026-10-05"
  });
  const parts = rounds.flatMap((r) => r.parts);
  // 1 つの許諾先から、作者 2 人（IN 条件 2 本）にそれぞれ来るはずの行が立つ。
  for (const id of [1, 2]) {
    assert.deepEqual(parts.find((p) => p.conditionId === id)!.expected.map((x) => x.outConditionId), [70]);
  }
});

test("outCoversWork：同じ作品・作品の無い OUT・派生作品の OUT は効く。元の作品の OUT は派生作品の IN には効かない", () => {
  assert.equal(outCoversWork({ workId: 1, lineageWorkIds: [1] }, 1), true);
  assert.equal(outCoversWork({ workId: null, lineageWorkIds: [] }, 1), true);
  assert.equal(outCoversWork({ workId: 2, lineageWorkIds: [2, 1] }, 1), true);
  assert.equal(outCoversWork({ workId: 1, lineageWorkIds: [1] }, 2), false);
});
