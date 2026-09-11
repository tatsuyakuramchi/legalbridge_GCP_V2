import test from "node:test";
import assert from "node:assert/strict";
import { dateStr, int, num, str } from "./db.js";

// node-postgres は date 列を JS の Date に変換する。String() すると
// "Fri Aug 28 2026 ..." になるため、日付の整形は必ず dateStr を通す。
test("dateStr は Date を YYYY-MM-DD にする（タイムゾーンでずらさない）", () => {
  assert.equal(dateStr(new Date(2026, 7, 28)), "2026-08-28");
  assert.equal(dateStr(new Date(2026, 0, 1)), "2026-01-01");
  assert.equal(dateStr("2026-08-28T00:00:00.000Z"), "2026-08-28");
  assert.equal(dateStr("2026-08-28"), "2026-08-28");
});

test("dateStr は空値を null にする", () => {
  assert.equal(dateStr(null), null);
  assert.equal(dateStr(undefined), null);
  assert.equal(dateStr(""), null);
});

test("str / num / int は空値を null に寄せる", () => {
  assert.equal(str("  "), null);
  assert.equal(str("x"), "x");
  assert.equal(num(""), null);
  assert.equal(num("12.5"), 12.5);
  assert.equal(int("12.9"), 12);
  assert.equal(int(null), null);
});
