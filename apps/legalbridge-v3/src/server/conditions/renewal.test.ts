import test from "node:test";
import assert from "node:assert/strict";
import { addMonths, renewalOf, renewalLabel, shortDate } from "./renewal.js";

/**
 * 許諾期間と自動更新（A-039）。更新の回数は列に持たず、終了日・単位・基準日
 * から数える。数え方がずれると、条件書に出る満了日がずれる。
 */

const terms = (over: Partial<Parameters<typeof renewalOf>[0]> = {}) => ({
  termStart: "2026-10-01", termEnd: "2031-09-30",
  autoRenew: true, renewMonths: 12, renewStoppedOn: null, ...over
});

test("満了日ちょうどはまだ更新していない。翌日から1回目", () => {
  assert.deepEqual(renewalOf(terms(), "2031-09-30"),
    { count: 0, currentEnd: "2031-09-30", stopped: false, renewing: true });
  assert.deepEqual(renewalOf(terms(), "2031-10-01"),
    { count: 1, currentEnd: "2032-09-30", stopped: false, renewing: true });
});

test("過ぎたぶんだけ数える（基準日が先でも1回ずつ足す）", () => {
  assert.equal(renewalOf(terms(), "2033-05-01").count, 2);
  assert.equal(renewalOf(terms(), "2033-05-01").currentEnd, "2033-09-30");
  assert.equal(renewalOf(terms(), "2041-01-01").count, 10);
});

test("単位は月。半年更新・2年更新も数えられる", () => {
  assert.equal(renewalOf(terms({ renewMonths: 6 }), "2032-10-01").count, 3);
  assert.equal(renewalOf(terms({ renewMonths: 24 }), "2032-10-01").count, 1);
  // 空なら1年として扱う（移行前の行）。2032-10-01 は 2 回目の満了日を過ぎている。
  assert.equal(renewalOf(terms({ renewMonths: null }), "2032-10-01").count, 2);
  assert.equal(renewalOf(terms({ renewMonths: null }), "2032-09-30").count, 1);
});

test("止めた日が来ていれば、そこで数が止まる（その期間は満了まで）", () => {
  const t = terms({ renewStoppedOn: "2033-05-01" });
  assert.deepEqual(renewalOf(t, "2040-01-01"),
    { count: 2, currentEnd: "2033-09-30", stopped: true, renewing: true });
  // 止める日がまだ来ていなければ、いつもどおり数える。
  assert.equal(renewalOf(t, "2032-01-01").stopped, false);
  assert.equal(renewalOf(t, "2032-01-01").count, 1);
});

test("自動更新しない・終了日が無い条件", () => {
  assert.deepEqual(renewalOf(terms({ autoRenew: false }), "2040-01-01"),
    { count: 0, currentEnd: "2031-09-30", stopped: false, renewing: false });
  assert.deepEqual(renewalOf(terms({ autoRenew: null }), "2040-01-01"),
    { count: 0, currentEnd: "2031-09-30", stopped: false, renewing: false });
  assert.deepEqual(renewalOf(terms({ termEnd: null }), "2040-01-01"),
    { count: 0, currentEnd: null, stopped: false, renewing: true });
});

test("月末は月末に寄せる（日付がずれていかない）", () => {
  // 2月29日の1年後は2月28日。そこから先もずれずに月末のまま。
  assert.equal(shortDate(renewalOf(terms({ termEnd: "2028-02-29" }), "2029-02-28").currentEnd), "2029.2.28");
  assert.equal(shortDate(renewalOf(terms({ termEnd: "2028-02-29" }), "2029-03-01").currentEnd), "2030.2.28");
  assert.equal(addMonths(new Date("2026-01-31T00:00:00Z"), 1).toISOString().slice(0, 10), "2026-02-28");
  assert.equal(addMonths(new Date("2026-03-30T00:00:00Z"), 1).toISOString().slice(0, 10), "2026-04-30");
});

test("一覧の行に出す1文", () => {
  assert.equal(renewalLabel(terms(), "2033-05-01"), "2026.10.1〜2033.9.30（更新 2回）");
  assert.equal(renewalLabel(terms({ autoRenew: false }), "2033-05-01"), "2026.10.1〜2031.9.30（更新なし）");
  assert.equal(renewalLabel(terms({ renewStoppedOn: "2033-05-01" }), "2040-01-01"),
    "2026.10.1〜2033.9.30（更新 2回・以後更新しない）");
  assert.equal(renewalLabel(terms({ termEnd: null }), "2033-05-01"), "2026.10.1〜（期間の定めなし）");
  assert.equal(renewalLabel(terms({ termStart: null, termEnd: null }), "2033-05-01"), "");
});
