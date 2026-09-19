import test from "node:test";
import assert from "node:assert/strict";
import { fixedPayDates, parsePaymentTerms, payDateFromTerms, payOnFor } from "./payment-terms.js";

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

test("締めの「月末」を支払日と読まない（A-040）", () => {
  // 「月末締め翌々月20日払い」は 20日払い。払いに近いほうの月より前を見ると、
  // "月末締め" を支払日と読んで末日（08-31）にしてしまっていた。
  assert.equal(on("2026-06-20", "月末締め翌々月20日払い"), "2026-08-20");
  assert.equal(on("2026-06-20", "月末締め翌月25日支払"), "2026-07-25");
  // 払いのほうが「末」なら、これまでどおり末日。
  assert.equal(on("2026-06-20", "月末締め翌月末払い"), "2026-07-31");
});

test("支払条件に日付そのものが入っているとき（V1・V2 から来た条件）", () => {
  assert.deepEqual(fixedPayDates("2026-12-31"), ["2026-12-31"]);
  assert.deepEqual(fixedPayDates("2026/12/31"), ["2026-12-31"]);
  assert.deepEqual(fixedPayDates("2026年12月31日"), ["2026-12-31"]);
  assert.deepEqual(fixedPayDates("2026-11-30、2026-12-31"), ["2026-11-30", "2026-12-31"]);
  assert.deepEqual(fixedPayDates("検収後30日"), [], "日付ではない");
  assert.deepEqual(fixedPayDates("2026-02-30"), [], "存在しない日は捨てる");
});

test("支払期日：規則が読めればそれ、読めなければ書いてある日付", () => {
  assert.equal(payDateFromTerms("2026-06-20", "月末締め翌月末払い"), "2026-07-31");
  assert.equal(payDateFromTerms("2026-06-20", "2026-12-31"), "2026-12-31");
  // 分割払いは、起算日のあとに来るいちばん早い日。
  assert.equal(payDateFromTerms("2026-06-20", "2026-10-31、2027-02-28、2027-03-31"), "2026-10-31");
  assert.equal(payDateFromTerms("2027-01-10", "2026-10-31、2027-02-28、2027-03-31"), "2027-02-28");
  // 全部過ぎていれば最後の日（それより後ろに約束は無い）。
  assert.equal(payDateFromTerms("2028-01-01", "2026-10-31、2027-03-31"), "2027-03-31");
  assert.equal(payDateFromTerms("2026-06-20", "検収後30日"), null, "読めないものは出さない");
  assert.equal(payDateFromTerms("2026-06-20", "請負"), null);
});
