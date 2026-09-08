import test from "node:test";
import assert from "node:assert/strict";
import { parsePaymentTerms, payOnFor } from "./payment-terms.js";

const on = (dueOn: string, terms: string) => payOnFor(dueOn, parsePaymentTerms(terms));

test("翌月末払い", () => {
  assert.equal(on("2026-04-30", "翌月末払い"), "2026-05-31");
  assert.equal(on("2026-01-31", "翌月末払い"), "2026-02-28");
});

test("検収月の翌月末払い（V1 に多い書き方）", () => {
  assert.equal(on("2026-04-30", "検収月の翌月末払い"), "2026-05-31");
});

test("当月末払い", () => {
  assert.equal(on("2026-04-30", "当月末払い"), "2026-04-30");
});

test("翌々月末払い", () => {
  assert.equal(on("2026-04-30", "翌々月末払い"), "2026-06-30");
  assert.equal(on("2026-04-30", "翌翌月末払い"), "2026-06-30");
});

test("日付指定の支払日", () => {
  assert.equal(on("2026-04-30", "翌月20日払い"), "2026-05-20");
  assert.equal(on("2026-04-30", "翌月25日支払"), "2026-05-25");
});

test("その月に無い日は末日へ寄せる", () => {
  assert.equal(on("2026-01-31", "翌月31日払い"), "2026-02-28");
});

test("締めと払いが両方あるときは、払いのほうを採る", () => {
  assert.equal(on("2026-04-30", "月末締め翌月末払い"), "2026-05-31");
  assert.equal(on("2026-04-30", "当月末締め翌々月末払い"), "2026-06-30");
});

test("全角の数字も読む（V1 の文言は表記が揺れている）", () => {
  assert.equal(on("2026-04-30", "翌月２０日払い"), "2026-05-20");
});

test("読めない書き方は無理に解釈しない", () => {
  // 推測で埋めると、間違った支払期日が黙って入って気づけない。
  assert.equal(parsePaymentTerms("30日以内"), null, "締め日が要るので月では出せない");
  assert.equal(parsePaymentTerms("別途協議"), null);
  assert.equal(parsePaymentTerms("翌月"), null, "日が読めないなら末日と決めつけない");
  assert.equal(parsePaymentTerms(""), null);
  assert.equal(parsePaymentTerms(null), null);
});

test("起点が無ければ支払期日も出ない", () => {
  assert.equal(payOnFor(null, { monthsAfter: 1, day: "end" }), null);
});
