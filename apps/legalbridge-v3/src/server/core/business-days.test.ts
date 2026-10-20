import test from "node:test";
import assert from "node:assert/strict";
import { addBusinessDays, isBusinessDay, japaneseHolidays, nextBusinessDay } from "./business-days.js";

test("祝日：固定日・ハッピーマンデー・春分秋分・振替休日・国民の休日", () => {
  const h2026 = japaneseHolidays(2026);
  assert.ok(h2026.has("2026-01-01"));
  assert.ok(h2026.has("2026-01-12"), "成人の日は 1 月第 2 月曜");
  assert.ok(h2026.has("2026-03-20"), "春分の日");
  assert.ok(h2026.has("2026-05-06"), "5/3 が日曜なので振替休日は 5/6");
  assert.ok(h2026.has("2026-09-21"), "敬老の日（第 3 月曜）");
  assert.ok(h2026.has("2026-09-22"), "敬老の日と秋分の日に挟まれた国民の休日");
  assert.ok(h2026.has("2026-09-23"), "秋分の日");
  assert.ok(!h2026.has("2026-12-23"), "天皇誕生日は 2/23 に移っている");
  assert.ok(japaneseHolidays(2027).has("2027-02-23"));
});

test("営業日の判定と加算", () => {
  assert.equal(isBusinessDay("2026-12-04"), true);   // 金
  assert.equal(isBusinessDay("2026-12-05"), false);  // 土
  assert.equal(isBusinessDay("2026-11-23"), false);  // 勤労感謝の日
  // 12/4（金）の翌日から 10 営業日 → 12/18（金）。祝日なし。
  assert.equal(addBusinessDays("2026-12-04", 10), "2026-12-18");
  // 年末年始をまたぐ：12/25（金）から 10 営業日 → 1/1 を飛ばして 1/12（成人の日 1/11 も飛ばす）。
  assert.equal(addBusinessDays("2026-12-25", 10), "2027-01-12");
  assert.equal(addBusinessDays("2026-12-04", 0), "2026-12-04");
  assert.equal(addBusinessDays("", 10), null);
});

test("休日なら次の営業日", () => {
  assert.equal(nextBusinessDay("2026-12-20"), "2026-12-21"); // 日 → 月
  assert.equal(nextBusinessDay("2026-12-21"), "2026-12-21");
  assert.equal(nextBusinessDay("2027-01-01"), "2027-01-04"); // 元日（金）→ 月
});
