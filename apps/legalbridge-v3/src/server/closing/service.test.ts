import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { ClosingService, monthsBetween, periodRow, printedDue } from "./service.js";

const TODAY = () => new Date("2026-09-21T00:00:00Z");

const head = (over: Record<string, unknown> = {}) => ({
  id: 7, condition_no: "COND-1", name: "月額保守", kind: "service",
  pricing_model: "subscription", direction: "out", currency: "JPY",
  term_start: new Date("2026-04-01T00:00:00Z"), term_end: new Date("2027-03-31T00:00:00Z"),
  party_id: 3, party_name: "受託者名", work_id: null, work_title: null,
  matter_id: 11, matter_title: "保守案件", period_count: 12, ...over
});

const line = (over: Record<string, unknown> = {}) => ({
  schedule_id: 100, seq: 1, label: "2026年4月分", planned_amount: 35000,
  due_on: new Date("2026-04-30T00:00:00Z"), pay_on: null,
  service_from: null, service_to: null,
  condition_id: 7, condition_no: "COND-1", condition_name: "月額保守",
  kind: "service", pricing_model: "subscription", currency: "JPY",
  payment_terms: "月末締め翌月末払い",
  party_id: 3, party_name: "受託者名", matter_id: 11, matter_title: "保守案件",
  event_id: null, event_on: null, event_amount: null,
  document_id: null, document_no: null, document_status: null, printed_due_on: null,
  payment_id: null, payment_no: null, payment_status: null, paid_on: null,
  allocated_amount: 0, ...over
});

// ---------------------------------------------------------------------------

test("刷られた期日は日付として読めるものだけ拾う", () => {
  assert.equal(printedDue("2026-09-30"), "2026-09-30");
  assert.equal(printedDue("翌月末"), null);
  assert.equal(printedDue("令和8年9月30日"), null);
  assert.equal(printedDue(null), null);
});

test("回の行は予定・実績・文書・支払を1行に畳む", () => {
  const row = periodRow(line({
    event_id: 200, event_on: new Date("2026-04-30T00:00:00Z"), event_amount: 35000,
    document_id: 300, document_no: "ARC-INS-2026-0001", document_status: "issued",
    printed_due_on: "2026-05-31"
  }), "2026-09-21", false);
  assert.equal(row.step, "payment");
  assert.equal(row.state, "支払待ち");
  assert.equal(row.documentLabel, "検収書");
  assert.equal(row.closingOn, "2026-04-30");
  assert.equal(row.monthKey, "2026-04");
  assert.equal(row.due.on, "2026-05-31");
  assert.equal(row.due.source, "printed");
});

test("料率の条件は計算書と報告待ちで出る", () => {
  const row = periodRow(line({
    kind: "license", pricing_model: "revenue_rate", planned_amount: 0
  }), "2026-09-21", false);
  assert.equal(row.state, "報告待ち");
  assert.equal(row.documentLabel, "計算書");
  assert.equal(row.plannedAmount, 0);
});

test("予定明細の支払日があれば期日はそれ", () => {
  const row = periodRow(line({ pay_on: new Date("2026-05-31T00:00:00Z"), printed_due_on: "2026-06-30" }),
    "2026-09-21", false);
  assert.equal(row.due.on, "2026-05-31");
  assert.equal(row.due.source, "schedule");
});

test("支払条件が空なら上限60日に落ちる", () => {
  const row = periodRow(line({ payment_terms: null }), "2026-09-21", false);
  assert.equal(row.due.source, "limit");
  assert.equal(row.due.on, "2026-06-29");
});

test("締め済みの回は遅れ日数を数えない", () => {
  const done = periodRow(line({
    event_id: 200, document_id: 300, payment_id: 400, allocated_amount: 35000
  }), "2026-09-21", false);
  assert.equal(done.step, "done");
  assert.equal(done.lateDays, 0);
  assert.equal(done.paidAmount, 35000);

  const late = periodRow(line(), "2026-09-21", false);
  assert.equal(late.lateDays, 144);
});

// ---------------------------------------------------------------------------

test("探す先が1つも無ければ断る（全件を並べない）", async () => {
  const db = new FakeDatabase(() => []);
  await assert.rejects(() => new ClosingService(db, TODAY).candidates({}), /探す先/);
  assert.equal(db.queries.length, 0);
});

test("語で探すと条件名・番号・相手先・作品を同じ番号で見る", async () => {
  const db = new FakeDatabase((t) => (t.includes("FROM conditions c") ? [head()] : []));
  const rows = await new ClosingService(db, TODAY).candidates({ q: "保守" });
  const q = db.find("ILIKE")!;
  assert.deepEqual(q.params, ["保守", 100]);
  // $? が残っていたら psql が落ちる。
  assert.ok(!q.text.includes("$?"), q.text);
  assert.equal((q.text.match(/\$1/g) ?? []).length, 4);
  assert.equal(rows[0]?.documentLabel, "検収書");
  assert.equal(rows[0]?.needsReport, false);
});

test("案件で絞ると matter_links を見る", async () => {
  const db = new FakeDatabase((t) => (t.includes("FROM conditions c") ? [head()] : []));
  await new ClosingService(db, TODAY).candidates({ matterId: 11 });
  const q = db.find("FROM conditions c")!;
  assert.match(q.text, /matter_links ml WHERE ml\.matter_id = \$1/);
  assert.equal(q.params[0], 11);
});

test("候補には残りの回と次の締め日が付く", async () => {
  const db = new FakeDatabase((t) => {
    if (t.includes("open_count")) return [{ condition_id: 7, open_count: 6, next_on: new Date("2026-10-31T00:00:00Z") }];
    if (t.includes("FROM conditions c")) return [head()];
    return [];
  });
  const rows = await new ClosingService(db, TODAY).candidates({ partyId: 3 });
  assert.equal(rows[0]?.openCount, 6);
  assert.equal(rows[0]?.nextClosingOn, "2026-10-31");
  assert.equal(rows[0]?.periodCount, 12);
});

test("候補が空なら残りを数えに行かない", async () => {
  const db = new FakeDatabase(() => []);
  const rows = await new ClosingService(db, TODAY).candidates({ partyId: 3 });
  assert.deepEqual(rows, []);
  assert.equal(db.find("open_count"), undefined);
});

test("回の一覧は予定の無い実績も混ぜる", async () => {
  const db = new FakeDatabase((t) => {
    if (t.includes("e.schedule_id IS NULL")) {
      return [line({
        schedule_id: null, seq: null, label: null, planned_amount: null,
        due_on: new Date("2026-05-15T00:00:00Z"),
        event_id: 900, event_on: new Date("2026-05-15T00:00:00Z"), event_amount: 12000
      })];
    }
    if (t.includes("FROM condition_schedules s")) return [line()];
    if (t.includes("FROM conditions c")) return [head()];
    return [];
  });
  const view = await new ClosingService(db, TODAY).periods(7);
  assert.equal(view.rows.length, 2);
  assert.equal(view.rows[0]?.unplanned, false);
  assert.equal(view.rows[1]?.unplanned, true);
  assert.equal(view.rows[1]?.scheduleId, null);
  assert.equal(view.total.planned, 35000);
  assert.equal(view.total.recorded, 12000);
  // 残りの数は予定の回だけで数える（浮いた実績は回ではない）。
  assert.equal(view.condition.openCount, 1);
  assert.equal(view.condition.nextClosingOn, "2026-04-30");
});

test("無い条件は NOT_FOUND", async () => {
  const db = new FakeDatabase(() => []);
  await assert.rejects(() => new ClosingService(db, TODAY).periods(7), /見つかりません/);
});

test("月の表は締め日で切り、段ごとに数える", async () => {
  const db = new FakeDatabase((t) => {
    if (t.includes("e.schedule_id IS NULL")) return [];
    if (t.includes("FROM condition_schedules s")) {
      return [
        line({ schedule_id: 101, seq: 6, due_on: new Date("2026-09-30T00:00:00Z") }),
        line({ schedule_id: 102, seq: 6, condition_id: 8, due_on: new Date("2026-09-30T00:00:00Z"),
               event_id: 1, document_id: 2, payment_id: 3, allocated_amount: 35000 })
      ];
    }
    return [];
  });
  const view = await new ClosingService(db, TODAY).month("2026-09");
  assert.equal(view.from, "2026-09-01");
  assert.equal(view.to, "2026-10-01");
  assert.deepEqual(view.counts, { event: 1, document: 0, payment: 0, done: 1 });
  const q = db.find("FROM condition_schedules s")!;
  assert.deepEqual(q.params.slice(0, 2), ["2026-09-01", "2026-10-01"]);
});

test("月の表も取引先で絞れる", async () => {
  const db = new FakeDatabase(() => []);
  await new ClosingService(db, TODAY).month("2026-09", { partyId: 3 });
  const q = db.find("FROM condition_schedules s")!;
  assert.match(q.text, /c\.counterparty_id = \$3/);
  assert.deepEqual(q.params, ["2026-09-01", "2026-10-01", 3]);
});

test("月の表は予定明細だけ（浮いた実績は混ぜない）", async () => {
  const db = new FakeDatabase((t) => {
    if (t.includes("FROM condition_schedules s")) return [line()];
    return [];
  });
  const view = await new ClosingService(db, TODAY).month("2026-09");
  assert.equal(view.rows.length, 1);
  assert.equal(view.rows[0]?.unplanned, false);
  // 浮いた実績の照会は流さない。別枠（strays）の仕事。
  assert.equal(db.find("e.schedule_id IS NULL"), undefined);
});

test("浮いた実績は「遅れ」と数えない（締め日が無い）", () => {
  const loose = periodRow({
    schedule_id: null, seq: null, label: null, planned_amount: null,
    due_on: "2026-09-01", pay_on: null, service_from: null, service_to: null,
    condition_id: 7, condition_no: null, condition_name: "浮いた実績",
    kind: "service", pricing_model: "fixed", currency: "JPY", payment_terms: null,
    party_id: 3, party_name: "受託者名", matter_id: null, matter_title: null,
    event_id: 900, event_on: "2026-09-01", event_amount: 12000,
    document_id: null, document_no: null, document_status: null, printed_due_on: null,
    payment_id: null, payment_no: null, payment_status: null, paid_on: null,
    allocated_amount: 0
  }, "2026-09-21", true);
  assert.equal(loose.lateDays, 0);
  // 予定の回なら同じ日付で20日遅れになる。
  assert.equal(periodRow(line({ due_on: "2026-09-01" }), "2026-09-21", false).lateDays, 20);
});

test("月の指定が YYYY-MM でなければ断る", async () => {
  const db = new FakeDatabase(() => []);
  await assert.rejects(() => new ClosingService(db, TODAY).month("2026/09"), /YYYY-MM/);
});

// ---------------------------------------------------------------------------

test("別枠：締め日を過ぎた回は実績の無いものだけ", async () => {
  const db = new FakeDatabase((t) => {
    if (t.includes("e.schedule_id IS NULL")) return [];
    if (t.includes("FROM condition_schedules s")) {
      return [line({ due_on: new Date("2026-07-31T00:00:00Z") })];
    }
    return [];
  });
  const view = await new ClosingService(db, TODAY).strays();
  assert.equal(view.overdue.length, 1);
  assert.equal(view.overdue[0]?.lateDays, 52);
  const q = db.find("FROM condition_schedules s")!;
  assert.match(q.text, /s\.due_on < \$1 AND e\.id IS NULL/);
  assert.equal(q.params[0], "2026-09-21");
});

test("別枠も取引先で絞れる（月の表と同じ絞り）", async () => {
  const db = new FakeDatabase(() => []);
  await new ClosingService(db, TODAY).strays({ partyId: 3 });
  const q = db.find("FROM condition_schedules s")!;
  assert.match(q.text, /c\.counterparty_id = \$2/);
  assert.match(db.find("e.schedule_id IS NULL")!.text, /c\.counterparty_id = \$2/);
  assert.deepEqual(q.params, ["2026-09-21", 3, 200]);
});

test("契約期間から回数の目安を出す（空なら画面から並べない）", async () => {
  const db = new FakeDatabase((t) => (t.includes("revenue_rate") ? [
    { id: 1, condition_no: "CL-1", name: "紙版｜出版許諾", rate_ppm: 100000,
      term_start: new Date("2024-04-01T00:00:00Z"), term_end: new Date("2029-03-31T00:00:00Z"),
      party_id: 3, party_name: "株式会社◆◆", work_id: null, work_title: null },
    { id: 2, condition_no: "CL-2", name: "電子版｜再許諾", rate_ppm: 125000,
      term_start: null, term_end: null,
      party_id: 3, party_name: "株式会社◆◆", work_id: null, work_title: null }
  ] : []));
  const rows = await new ClosingService(db, TODAY).royaltyGaps();
  assert.equal(rows[0]?.schedulable, true);
  assert.equal(rows[0]?.monthSpan, 60);
  assert.equal(rows[1]?.schedulable, false);
  assert.equal(rows[1]?.monthSpan, null);
  // 予定が1本でもある条件は出さない。
  assert.match(db.find("revenue_rate")!.text, /NOT EXISTS \(SELECT 1 FROM condition_schedules/);
});

test("契約期間の月数は両端を含む", () => {
  assert.equal(monthsBetween("2024-04-01", "2029-03-31"), 60);
  assert.equal(monthsBetween("2026-04-01", "2026-04-30"), 1);
  assert.equal(monthsBetween("2026-04-01", "2026-03-31"), null);
  assert.equal(monthsBetween(null, "2026-03-31"), null);
});
