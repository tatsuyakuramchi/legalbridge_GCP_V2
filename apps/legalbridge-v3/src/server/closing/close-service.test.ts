import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { ClosingCloseService, REFUSAL_LABEL, refusalFor } from "./close-service.js";
import { periodRow } from "./service.js";

const TODAY = "2026-09-21";
const now = () => new Date(`${TODAY}T00:00:00Z`);

const row = (over: Record<string, unknown> = {}) => periodRow({
  schedule_id: 100, seq: 1, label: "2026年7月分", planned_amount: 35000,
  due_on: "2026-07-31", pay_on: "2026-08-31", service_from: null, service_to: null,
  condition_id: 7, condition_no: "COND-1", condition_name: "月額保守",
  kind: "service", pricing_model: "subscription", currency: "JPY",
  payment_terms: "月末締め翌月末払い",
  party_id: 3, party_name: "受託者名", matter_id: 11, matter_title: "保守案件",
  event_id: null, event_on: null, event_amount: null,
  document_id: null, document_no: null, document_status: null, printed_due_on: null,
  payment_id: null, payment_no: null, payment_status: null, paid_on: null,
  allocated_amount: 0, ...over
}, TODAY, over.schedule_id === null);

test("締められない理由は前から順に見る", () => {
  assert.equal(refusalFor(row(), TODAY), null);
  assert.equal(refusalFor(row({ event_id: 1, document_id: 2, payment_id: 3 }), TODAY), "done");
  assert.equal(refusalFor(row({ schedule_id: null }), TODAY), "unplanned");
  assert.equal(refusalFor(row({ due_on: null }), TODAY), "no_closing_date");
});

test("締め日が来ていない回は締めない（紙の決定日が先の日付になる）", () => {
  assert.equal(refusalFor(row({ due_on: "2026-09-30" }), TODAY), "not_yet");
  assert.equal(refusalFor(row({ due_on: "2026-09-21" }), TODAY), null);
  assert.equal(row({ due_on: "2026-09-30" }).state, "これから");
});

test("料率は売上報告が無いと締めない（金額が出ない）", () => {
  const royalty = { kind: "license", pricing_model: "revenue_rate", planned_amount: 0 };
  assert.equal(refusalFor(row(royalty), TODAY), "needs_report");
  // 報告が入って実績になっていれば、文書から先は同じ。
  assert.equal(refusalFor(row({ ...royalty, event_id: 5, event_amount: 600000 }), TODAY), null);
});

test("予定額の無い回は「予定どおり」で記録できない", () => {
  assert.equal(refusalFor(row({ planned_amount: 0 }), TODAY), "no_planned_amount");
  assert.equal(refusalFor(row({ planned_amount: null }), TODAY), "no_planned_amount");
});

test("理由には人に読める言葉が付く", () => {
  assert.match(REFUSAL_LABEL.needs_report, /売上報告/);
  assert.match(REFUSAL_LABEL.not_yet, /締め日/);
});

// ---------------------------------------------------------------------------

/** preview / run が読む形の偽データベース。回は条件ごとに読み直される。 */
const db = (rows: Array<Record<string, unknown>>, over: Record<string, any[]> = {}) =>
  new FakeDatabase((t) => {
    for (const [fragment, out] of Object.entries(over)) if (t.includes(fragment)) return out;
    if (t.includes("SELECT DISTINCT condition_id")) {
      return [...new Set(rows.map((r) => Number(r.condition_id)))].map((id) => ({ condition_id: id }));
    }
    if (t.includes("e.schedule_id IS NULL")) return [];
    if (t.includes("FROM condition_schedules s\n    JOIN conditions c")) return rows;
    if (t.includes("FROM conditions c\n    LEFT JOIN parties p")) {
      return [{ id: rows[0]?.condition_id, condition_no: "COND-1", name: "月額保守",
                kind: rows[0]?.kind ?? "service", pricing_model: rows[0]?.pricing_model ?? "subscription",
                direction: "out", currency: "JPY", term_start: null, term_end: null,
                party_id: 3, party_name: "受託者名", work_id: null, work_title: null,
                matter_id: 11, matter_title: "保守案件", period_count: rows.length }];
    }
    if (t.includes("number_prefix")) return [{ number_prefix: "ARC-INS" }];
    if (t.includes("current_value")) return [{ current_value: 1035 }];
    return [];
  });

const raw = (over: Record<string, unknown> = {}) => ({
  schedule_id: 100, seq: 1, label: "2026年7月分", planned_amount: 35000,
  due_on: "2026-07-31", pay_on: "2026-08-31", service_from: null, service_to: null,
  condition_id: 7, condition_no: "COND-1", condition_name: "月額保守",
  kind: "service", pricing_model: "subscription", currency: "JPY",
  payment_terms: "月末締め翌月末払い",
  party_id: 3, party_name: "受託者名", matter_id: 11, matter_title: "保守案件",
  event_id: null, event_on: null, event_amount: null,
  document_id: null, document_no: null, document_status: null, printed_due_on: null,
  payment_id: null, payment_no: null, payment_status: null, paid_on: null,
  allocated_amount: 0, ...over
});

test("試算は枚数・番号・合計・期日の根拠まで出す", async () => {
  const service = new ClosingCloseService(db([
    raw(), raw({ schedule_id: 101, seq: 2, label: "2026年8月分", due_on: "2026-08-31" })
  ]), now);
  const view = await service.preview([100, 101]);
  assert.equal(view.summary.rows, 2);
  assert.equal(view.summary.events, 2);
  // 同じ条件の2回は検収書1枚にまとめる。
  assert.equal(view.summary.documents, 1);
  assert.equal(view.documents[0]?.scheduleIds.length, 2);
  // 1枚に載せるときの決定日は、いちばん遅い締め日。
  assert.equal(view.documents[0]?.issuedOn, "2026-08-31");
  assert.equal(view.summary.total, 70000);
  assert.equal(view.numbers[0]?.from, "ARC-INS-2026-1036");
  assert.equal(view.numbers[0]?.to, "ARC-INS-2026-1036");
  assert.equal(view.summary.dueByLimit, 0);
});

test("試算は条件ごとに別の紙にする（相手先が混ざらない）", async () => {
  const service = new ClosingCloseService(db([
    raw(), raw({ schedule_id: 200, condition_id: 8 })
  ]), now);
  const view = await service.preview([100, 200]);
  assert.equal(view.summary.documents, 2);
  assert.equal(view.summary.payments, 2);
});

test("試算は支払条件の無い回を数える（上限60日になる合図）", async () => {
  const service = new ClosingCloseService(db([raw({ pay_on: null, payment_terms: null })]), now);
  const view = await service.preview([100]);
  assert.equal(view.summary.dueByLimit, 1);
  assert.equal(view.targets[0]?.dueSource, "limit");
});

test("締められない回は対象から外し、理由を返す", async () => {
  const service = new ClosingCloseService(db([
    raw(), raw({ schedule_id: 101, seq: 2, due_on: "2026-12-31" })
  ]), now);
  const view = await service.preview([100, 101]);
  assert.equal(view.targets.length, 1);
  assert.equal(view.skipped[0]?.reason, "not_yet");
  assert.equal(view.skipped[0]?.seq, 2);
});

test("選んでいない回は断る", async () => {
  const service = new ClosingCloseService(db([]), now);
  await assert.rejects(() => service.preview([]), /選んでください/);
  await assert.rejects(() => service.preview(Array.from({ length: 201 }, (_, i) => i + 1)), /200回まで/);
});

test("無い回を混ぜたら、どれが無いかを言って断る", async () => {
  const service = new ClosingCloseService(db([raw()]), now);
  await assert.rejects(() => service.preview([100, 999]), /999/);
});
