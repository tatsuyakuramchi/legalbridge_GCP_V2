import assert from "node:assert/strict";
import test from "node:test";
import { dateOnly, scopeRows } from "./repository.js";

test("work rights date values are serialized as Tokyo calendar dates", () => {
  const value = new Date("2026-05-12T15:00:00.000Z");
  assert.equal(dateOnly(value), "2026-05-13");
  assert.equal(dateOnly("2026-05-13"), "2026-05-13");
});

test("canonical scope child rows take precedence over compatibility text", () => {
  assert.deepEqual(
    scopeRows([{ code: "WORLD", name: "全世界" }], "日本のみ", "region"),
    [{ code: "WORLD", name: "全世界" }]
  );
  assert.deepEqual(
    scopeRows([{ code: "ALL", name: "全言語" }], "日本語", "language"),
    [{ code: "ALL", name: "全言語" }]
  );
});

test("legacy scope text remains a fallback only when child rows are absent", () => {
  assert.deepEqual(
    scopeRows([], "全世界", "region"),
    [{ code: "WORLD", name: "全世界" }]
  );
  assert.deepEqual(
    scopeRows([], "全言語", "language"),
    [{ code: "ALL", name: "全言語" }]
  );
});
