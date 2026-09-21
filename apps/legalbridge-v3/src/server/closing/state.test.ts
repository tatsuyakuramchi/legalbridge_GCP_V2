import test from "node:test";
import assert from "node:assert/strict";
import {
  needsReport, stepOf, stateLabel, dueOf, DUE_SOURCE_LABEL,
  monthKeyOf, monthRange, lateDays
} from "./state.js";

test("料率だけが売上報告を待つ", () => {
  assert.equal(needsReport("revenue_rate"), true);
  assert.equal(needsReport("fixed"), false);
  assert.equal(needsReport(null), false);
  assert.equal(needsReport(undefined), false);
});

test("段は前から順に見る（実績が無ければ文書の話はしない）", () => {
  const at = (e: boolean, d: boolean, p: boolean) =>
    stepOf({ hasEvent: e, hasDocument: d, hasPayment: p });
  assert.equal(at(false, false, false), "event");
  assert.equal(at(true, false, false), "document");
  assert.equal(at(true, true, false), "payment");
  assert.equal(at(true, true, true), "done");
  // 文書や支払が先にあっても、実績が無ければ実績待ち。
  assert.equal(at(false, true, true), "event");
});

test("料率の実績待ちは「報告待ち」と呼ぶ（催促する先が違う）", () => {
  assert.equal(stateLabel({ step: "event", pricingModel: "revenue_rate", kind: "license" }), "報告待ち");
  assert.equal(stateLabel({ step: "event", pricingModel: "fixed", kind: "service" }), "実績待ち");
});

test("文書待ちは条件の種類で呼び名が変わる", () => {
  assert.equal(stateLabel({ step: "document", pricingModel: "fixed", kind: "service" }), "検収書待ち");
  assert.equal(stateLabel({ step: "document", pricingModel: "revenue_rate", kind: "license" }), "計算書待ち");
  assert.equal(stateLabel({ step: "document", pricingModel: "revenue_rate", kind: "product" }), "計算書待ち");
  assert.equal(stateLabel({ step: "payment", pricingModel: "fixed", kind: "service" }), "支払待ち");
  assert.equal(stateLabel({ step: "done", pricingModel: "fixed", kind: "service" }), "締め済");
});

test("期日は予定明細がいちばん強い", () => {
  const due = dueOf({
    schedulePayOn: "2026-08-31",
    printedDueOn: "2026-09-30",
    paymentTerms: "月末締め翌月末払い",
    basisOn: "2026-07-31"
  });
  assert.equal(due.on, "2026-08-31");
  assert.equal(due.source, "schedule");
  assert.equal(due.label, DUE_SOURCE_LABEL.schedule);
});

test("予定明細が無ければ紙に刷られた期日", () => {
  const due = dueOf({ printedDueOn: "2026-09-30", paymentTerms: "月末締め翌月末払い", basisOn: "2026-07-31" });
  assert.equal(due.on, "2026-09-30");
  assert.equal(due.source, "printed");
});

test("紙も無ければ条件の支払条件から数える", () => {
  const due = dueOf({ paymentTerms: "月末締め翌月末払い", basisOn: "2026-07-31" });
  assert.equal(due.source, "terms");
  assert.equal(due.on, "2026-08-31");
});

test("支払条件が空なら上限60日に落ちる（約束の日ではないと断る）", () => {
  const due = dueOf({ basisOn: "2026-06-20" });
  assert.equal(due.on, "2026-08-19");
  assert.equal(due.source, "limit");
  assert.match(due.label, /約束の日ではない/);
});

test("起算日が無ければ決められない", () => {
  const due = dueOf({ paymentTerms: "月末締め翌月末払い" });
  assert.equal(due.on, null);
  assert.equal(due.source, "none");
});

test("空文字は値として扱わない", () => {
  const due = dueOf({ schedulePayOn: "  ", printedDueOn: "", basisOn: "2026-06-20" });
  assert.equal(due.source, "limit");
});

test("月は締め日で切る", () => {
  assert.equal(monthKeyOf("2026-07-31"), "2026-07");
  assert.equal(monthKeyOf(null), null);
  assert.equal(monthKeyOf(""), null);
  assert.equal(monthKeyOf("むかし"), null);
});

test("月の範囲は翌月1日まで（年をまたいでも）", () => {
  assert.deepEqual(monthRange("2026-07"), { from: "2026-07-01", to: "2026-08-01" });
  assert.deepEqual(monthRange("2026-12"), { from: "2026-12-01", to: "2027-01-01" });
  assert.throws(() => monthRange("2026-7"), RangeError);
  assert.throws(() => monthRange("2026"), RangeError);
});

test("締め日を過ぎた日数、過ぎていなければ0", () => {
  assert.equal(lateDays("2026-07-31", "2026-08-10"), 10);
  assert.equal(lateDays("2026-07-31", "2026-07-31"), 0);
  assert.equal(lateDays("2026-07-31", "2026-07-01"), 0);
  assert.equal(lateDays(null, "2026-08-10"), 0);
});
