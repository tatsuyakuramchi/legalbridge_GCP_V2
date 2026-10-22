import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { DealsService } from "./service.js";

/** 一回きり（once）の業務委託。回（condition_schedules）は無く、実績が 1 件だけある。 */
const cond = (over: Record<string, unknown> = {}) => ({
  condition_id: 1554, condition_no: "CL-2026-00968", condition_name: "イベント運営業務", kind: "service",
  pricing_model: "unit_rate", currency: "JPY", payment_terms: null, direction: "in", usage_type: null,
  term_start: null, term_end: null, settlement_mode: "once", settlement_count: null, settlement_cycle: null,
  settlement_grace_days: null, time_settlement: false, contract_form: "準委任",
  party_id: 7, party_name: "瀬戸美月", work_id: null, work_title: null, matter_id: null, matter_title: null,
  planned_n: 0, ...over
});
const loose = (over: Record<string, unknown> = {}) => ({
  ...cond(), schedule_id: null, seq: null, label: null, planned_amount: null,
  due_on: "2026-10-21", pay_on: null, service_from: null, service_to: null,
  event_id: 4167, event_on: "2026-10-21", event_amount: 13500,
  document_id: null, document_no: null, document_status: null, document_sent_at: null, printed_due_on: null,
  payment_id: null, payment_no: null, payment_status: null, paid_on: null, allocated_amount: 0, skipped: false, ...over
});

const db = (events: Array<Record<string, unknown>>) => new FakeDatabase((t) => {
  if (t.includes("AS planned_n")) return [cond()];
  if (t.includes("WHERE e.schedule_id IS NULL")) return events;
  if (t.includes("FROM condition_schedules s")) return [];
  return undefined;
});

test("一回きりで回が無く、回に結び付けずに入れた実績があるとき：実績の行だけ。「1 / 1 いつでも」の次の回は足さない", async () => {
  const rows = (await new DealsService(db([loose()]), () => new Date("2026-10-21T00:00:00Z")).list({}, "all")).rows;
  assert.deepEqual(rows.map((r) => r.rowKind), ["unplanned"]);
  assert.equal(rows[0]!.templateKey, "service_completion_notice", "準委任なので役務提供完了通知書");
});

test("一回きりで実績がまだ無ければ「次の回」が出る。実績が支払まで済んでいれば残り 0 で出ない", async () => {
  const none = (await new DealsService(db([]), () => new Date("2026-10-21T00:00:00Z")).list({}, "all")).rows;
  assert.deepEqual(none.map((r) => r.rowKind), ["next"]);
  assert.equal(none[0]!.roundLabel, "1 / 1");
  const paid = (await new DealsService(db([loose({ payment_id: 9, payment_no: "PAY-9", payment_status: "paid", paid_on: "2026-10-25", allocated_amount: 13500 })]),
                                        () => new Date("2026-10-21T00:00:00Z")).list({}, "all")).rows;
  assert.deepEqual(paid.map((r) => r.rowKind), ["unplanned"], "済んだ実績の行だけ。次の回は残り 0 なので出ない");
});
