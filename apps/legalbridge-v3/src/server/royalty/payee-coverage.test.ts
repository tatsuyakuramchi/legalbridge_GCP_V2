import test from "node:test";
import assert from "node:assert/strict";
import { buildCoverage, missingPayees, payeesComplete } from "./payee-coverage.js";
import { receiptInState } from "./receipts.js";
import { buildRounds, type LedgerCondition, type LedgerEvent } from "./ledger-service.js";

const shares = [
  { series: 10, conditionId: 10, partyId: 1, name: "作者A", distribution: null },
  { series: 10, conditionId: 10, partyId: 2, name: "イラストB", distribution: null }
];

test("当社が各人に払う取り分：受取人全員の計算書がそろって済。1 人目だけでは済にしない", () => {
  const one = buildCoverage([{ eventId: 500, series: 10 }], shares, [{ eventId: 500, payeePartyId: 1, documentId: 900 }]);
  assert.equal(payeesComplete(one.get(500)), false);
  assert.deepEqual(missingPayees(one.get(500)), ["イラストB"]);
  const both = buildCoverage([{ eventId: 500, series: 10 }], shares,
    [{ eventId: 500, payeePartyId: 1, documentId: 900 }, { eventId: 500, payeePartyId: 2, documentId: 901 }]);
  assert.equal(payeesComplete(both.get(500)), true);
  assert.deepEqual(both.get(500)!.documentIds, [900, 901], "受取人ごとの計算書を両方持つ");
});

test("代表が受け取って分ける・取り分の無い条件は 1 枚で済", () => {
  const rep = buildCoverage([{ eventId: 500, series: 10 }], shares.map((s) => ({ ...s, distribution: "representative" })), []);
  assert.deepEqual(rep.get(500)!.required, []);
  assert.equal(payeesComplete(rep.get(500)), true);
  const none = buildCoverage([{ eventId: 501, series: 11 }], shares, []);
  assert.equal(payeesComplete(none.get(501)), true);
});

test("改訂で版が変わったら、いちばん新しい版の取り分で数える", () => {
  const cov = buildCoverage([{ eventId: 500, series: 10 }],
    [...shares, { series: 10, conditionId: 12, partyId: 3, name: "翻訳C", distribution: null }], []);
  assert.deepEqual(cov.get(500)!.required.map((p) => p.name), ["翻訳C"]);
});

test("入金に対する作者の状態：受取人の計算書がそろうまで計算書待ち", () => {
  assert.equal(receiptInState(1000, [{ grossAmount: 1000, documentId: 900, payees: { missing: ["イラストB"] } }]), "waiting");
  assert.equal(receiptInState(1000, [{ grossAmount: 1000, documentId: 900, payees: { missing: [] } }]), "issued");
});

test("台帳の回：受取人の計算書がそろうまで計算書済にしない", () => {
  const cond: LedgerCondition = { id: 1, conditionNo: null, name: "c", usageType: "pub_print", usageLabel: "", workId: 1, workTitle: "ito",
    agreementId: null, agreementNo: null, pricingModel: "revenue_rate", ratePpm: 100000, unitAmount: null, mgAmount: null, agAmount: null,
    currency: "JPY", paymentTerms: null, timing: "event", timingExplicit: true, schedules: 0 };
  const ev = (over: Partial<LedgerEvent>): LedgerEvent => ({ id: 5, conditionId: 1, scheduleId: null, eventType: "manufacturing",
    occurredOn: "2026-06-01", period: null, usageType: null, outConditionId: null, outName: null, workId: null, workTitle: null,
    quantity: 1, unitAmount: null, grossAmount: 100, amount: 10, documentId: 900, ...over });
  const state = (e: LedgerEvent) => buildRounds({ conditions: [cond], schedules: [], events: [e], skips: [], outs: [],
    bundle: "single_work", today: "2026-10-01" })[0].parts[0].state;
  assert.equal(state(ev({ missingPayees: ["イラストB"] })), "reported");
  assert.equal(state(ev({ missingPayees: [] })), "issued");
});
