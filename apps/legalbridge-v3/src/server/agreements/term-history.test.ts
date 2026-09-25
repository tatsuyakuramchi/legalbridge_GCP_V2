import test from "node:test";
import assert from "node:assert/strict";
import { termHistory, initialMonths } from "./term-history.js";

const base = { termStart: "2024-04-01", termEnd: "2025-03-31", autoRenew: true, renewMonths: null };

test("Start → (1) → (2) → End。最終行の終了日がいまの終了日", () => {
  const h = termHistory(base, "2026-09-22");
  assert.deepEqual(h.rows.map((r) => [r.start, r.end, r.label]), [
    ["2024-04-01", "2025-03-31", "Start"],
    ["2025-04-01", "2026-03-31", "(1)"],
    ["2026-04-01", "2027-03-31", "End"]
  ]);
  assert.equal(h.currentEnd, "2027-03-31");
  assert.equal(h.renewals, 2);
  assert.equal(h.stopped, false);
});

test("更新の単位が空なら当初の期間と同じ長さ（半年契約は半年ずつ）", () => {
  assert.equal(initialMonths(new Date("2024-04-01T00:00:00Z"), new Date("2024-09-30T00:00:00Z")), 6);
  const h = termHistory({ ...base, termEnd: "2024-09-30" }, "2025-01-15");
  assert.deepEqual(h.rows.map((r) => r.end), ["2024-09-30", "2025-03-31"]);
});

test("満了日ちょうどはまだ更新していない", () => {
  const h = termHistory(base, "2025-03-31");
  assert.equal(h.rows.length, 1);
  assert.equal(h.rows[0]?.label, "Start / End");
  assert.equal(termHistory(base, "2025-04-01").rows.length, 2);
});

test("不更新の日で止まる（その期間は満了まで）", () => {
  const h = termHistory({ ...base, renewStoppedOn: "2025-10-01" }, "2027-06-01");
  assert.deepEqual(h.rows.map((r) => r.end), ["2025-03-31", "2026-03-31"]);
  assert.equal(h.stopped, true);
  assert.equal(h.terminated, false);
});

test("解除は最終行を解除日で切る。前の行は触らない", () => {
  const h = termHistory({ ...base, events: [
    { kind: "terminated", onDate: "2026-09-30", basis: "ARC-ISA-2026-0002-T01" }
  ] }, "2027-06-01");
  assert.deepEqual(h.rows.map((r) => [r.end, r.label, r.kind]), [
    ["2025-03-31", "Start", "initial"],
    ["2026-03-31", "(1)", "auto"],
    ["2026-09-30", "End", "terminated"]
  ]);
  assert.match(h.rows[2]!.basis, /解除合意 ARC-ISA-2026-0002-T01/);
  assert.equal(h.currentEnd, "2026-09-30");
  assert.equal(h.terminated, true);
});

test("合意による更新は終了日を決め直す（自動更新なしでも行になる）", () => {
  const h = termHistory({ ...base, autoRenew: false, events: [
    { kind: "renewed", onDate: "2025-03-15", newEnd: "2027-03-31", basis: "…-S01" }
  ] }, "2026-09-22");
  assert.deepEqual(h.rows.map((r) => [r.start, r.end, r.kind]), [
    ["2024-04-01", "2025-03-31", "initial"],
    ["2025-04-01", "2027-03-31", "renewed"]
  ]);
  assert.match(h.rows[1]!.basis, /合意更新/);
});

test("期限の定めなし・日付なし", () => {
  const open = termHistory({ termStart: "2025-04-01", termEnd: null, autoRenew: true, renewMonths: 12 });
  assert.equal(open.rows.length, 1);
  assert.equal(open.currentEnd, null);
  assert.equal(termHistory({ termStart: null, termEnd: null, autoRenew: null, renewMonths: null }).rows.length, 0);
});
