import test from "node:test";
import assert from "node:assert/strict";
import { exTaxOf, itemNameOf, planJudgeOrder, whenText, JUDGE_DUTIES, type JudgeDay } from "./plan.js";

const omiya = { id: 2, name: "ホビーステーション大宮店", shortName: "HBST大宮" };
const tsudanuma = { id: 1, name: "ホビーステーション津田沼店", shortName: "HBST津田沼" };
const stores = [omiya, tsudanuma];
const day = (over: Partial<JudgeDay>): JudgeDay => ({
  date: "2026-11-18", startTime: "12:00", eventName: "氷星杯", storeId: 2, feeIncTax: 12000, travelIncTax: 502, ...over
});

test("税込 → 税抜は 1 円未満切り捨て（過去の発注書の額と同じ）", () => {
  assert.equal(exTaxOf(13000), 11818);
  assert.equal(exTaxOf(12000), 10909);
  assert.equal(exTaxOf(18000), 16363);
  assert.equal(exTaxOf(0), 0);
});

test("日時は曜日つき・終わりを書かない", () => {
  assert.equal(whenText("2026-11-29", "12:00"), "2026/11/29(日) 12:00〜");
});

test("1 日だけ：品目名は日付、実績の発注書（ARC-PO-2026-1165）と同じ形", () => {
  const plan = planJudgeOrder({ days: [day({ date: "2026-11-29" })], stores, partyKind: "individual" });
  assert.deepEqual(plan.issues, []);
  assert.equal(plan.lines.length, 1);
  const [l] = plan.lines;
  assert.equal(l.itemName, "審判業務（2026/11/29‗HBST大宮）");
  assert.equal(l.quantity, 1);
  assert.equal(l.unitPrice, 10909);
  assert.equal(l.spec, `イベント名：氷星杯\n日時：2026/11/29(日) 12:00〜\n場所：ホビーステーション大宮店\n${JUDGE_DUTIES}`);
  assert.equal(plan.subject, "ホビステ11月開催ジャッジ業務");
  assert.deepEqual(plan.expenses, [{ date: "2026-11-29", amount: 502 }]);
  // 個人は翌月 20 日
  assert.equal(plan.payOn, "2026-12-20");
});

test("同じイベントを複数日：1 行・数量＝日数、日時は日ごと", () => {
  const plan = planJudgeOrder({ days: [day({ date: "2026-11-25" }), day({ date: "2026-11-18" })], stores, partyKind: "individual" });
  assert.equal(plan.lines.length, 1);
  const [l] = plan.lines;
  assert.equal(l.itemName, "審判業務（氷星杯 2日‗HBST大宮）");
  assert.equal(l.quantity, 2);
  assert.equal(l.amount, 21818);
  assert.deepEqual(l.dates, ["2026-11-18", "2026-11-25"]);
  assert.match(l.spec, /日時：2026\/11\/18\(水\) 12:00〜\n日時：2026\/11\/25\(水\) 12:00〜/);
  assert.equal(l.termStart, "2026-11-18");
  assert.equal(l.termEnd, "2026-11-25");
  // 交通費は開催日ごと
  assert.deepEqual(plan.expenses.map((e) => e.date), ["2026-11-18", "2026-11-25"]);
  assert.equal(plan.travelTotal, 1004);
});

test("違うイベント・違う店舗・違う単価は行を分ける", () => {
  const plan = planJudgeOrder({ days: [
    day({ date: "2026-11-18" }),
    day({ date: "2026-11-25", eventName: "ストアチャンピオンシップ" }),
    day({ date: "2026-11-21", storeId: 1 }),
    day({ date: "2026-11-28", feeIncTax: 13000 })
  ], stores, partyKind: "individual" });
  assert.equal(plan.lines.length, 4);
  assert.equal(plan.subtotal, 10909 * 3 + 11818);
});

test("交通費なしの日は経費に出ない", () => {
  const plan = planJudgeOrder({ days: [day({ travelIncTax: null }), day({ date: "2026-11-25", travelIncTax: 0 })], stores });
  assert.deepEqual(plan.expenses, []);
  assert.equal(plan.lines.length, 1);
});

test("法人は翌月末日払い", () => {
  const plan = planJudgeOrder({ days: [day({ date: "2026-12-06" })], stores, partyKind: "corporate" });
  assert.equal(plan.payOn, "2027-01-31");
});

test("読めない行・月またぎ・重複は不備に出す", () => {
  const plan = planJudgeOrder({ days: [
    day({ date: "2026-11-31" }), day({ eventName: "" }), day({ storeId: 9 }), day({ feeIncTax: 0 }),
    day({ date: "2026-11-30" }), day({ date: "2026-12-01" }), day({ date: "2026-12-01" })
  ], stores });
  assert.ok(plan.issues.some((i) => /開催日が読めません/.test(i)));
  assert.ok(plan.issues.some((i) => /イベント名が空/.test(i)));
  assert.ok(plan.issues.some((i) => /店舗が選ばれていません/.test(i)));
  assert.ok(plan.issues.some((i) => /委託料/.test(i)));
  assert.ok(plan.issues.some((i) => /またがっています/.test(i)));
  assert.ok(plan.issues.some((i) => /2 回入っています/.test(i)));
  assert.equal(planJudgeOrder({ days: [], stores }).issues[0], "開催日を 1 日以上入れてください");
});

test("略称が空なら店舗名で", () => {
  assert.equal(itemNameOf("氷星杯", ["2026-11-01", "2026-11-08"], { id: 3, name: "某店", shortName: "" }), "審判業務（氷星杯 2日‗某店）");
});
