import test from "node:test";
import assert from "node:assert/strict";
import {
  customField, dateOnly, fromIssue, guessKind, requestNoInSummary, requesterSlackId, tokyoDate
} from "./guess.js";

test("種類は課題種別と件名の語から推す", () => {
  assert.equal(guessKind("納品・検収", "[納品報告] 第2回"), "outsourcing");
  assert.equal(guessKind("契約審査", "【文書作成】株式会社甲_発注書"), "outsourcing");
  assert.equal(guessKind("契約審査", "【文書作成】株式会社乙_個別利用許諾条件"), "work");
  assert.equal(guessKind("利用許諾計算", "2026年上期"), "work");
  assert.equal(guessKind("法務相談", "景品表示法の確認"), "single");
});

test("当てにならないときは推さない。それらしい値で埋めない", () => {
  assert.equal(guessKind("契約審査", "テスト投稿"), null);
  assert.equal(guessKind(null, null), null);
});

test("カスタム属性は選択型なら名前にする", () => {
  const issue = { id: 1, issueKey: "LEGAL-1", customFields: [
    { name: "取引先名称", value: "株式会社甲" },
    { name: "依頼種別", value: { id: 3, name: "発注書" } },
    { name: "空", value: "  " }
  ] };
  assert.equal(customField(issue, "取引先名称"), "株式会社甲");
  assert.equal(customField(issue, "依頼種別"), "発注書");
  assert.equal(customField(issue, "空"), null);
  assert.equal(customField(issue, "無い"), null);
});

test("依頼者は説明欄の Slack メンションから拾う（V1 の Slack 受付の書き方）", () => {
  assert.equal(requesterSlackId("依頼者 <@U04YAMAMOTO> です"), "U04YAMAMOTO");
  assert.equal(requesterSlackId("メンションなし"), null);
});

test("日付・東京の日付・件名の依頼番号", () => {
  assert.equal(dateOnly("2026/10/02 00:00"), "2026-10-02");
  assert.equal(dateOnly("来週"), null);
  // 09/24 16:00Z は東京では 09/25
  assert.equal(tokyoDate(new Date("2026-09-24T16:00:00Z")), "2026-09-25");
  assert.equal(requestNoInSummary("[REQ-2026-00012] 追加発注"), "REQ-2026-00012");
  assert.equal(requestNoInSummary("追加発注 [REQ-2026-00012]"), null, "頭にあるときだけ（自分が立てた課題の形）");
});

test("課題から受付箱の行を作る。希望納期は属性を優先し、無ければ期限日", () => {
  const f = fromIssue({
    id: 1, issueKey: "LEGAL-9", summary: "【納品・検収】株式会社甲_第2回納品",
    description: "<@U1>\n対象契約番号: ARC-PO-2026-0188", issueType: { name: "納品・検収" },
    createdUser: { name: "山本" }, dueDate: "2026-10-31T00:00:00Z",
    customFields: [{ name: "取引先名称", value: "株式会社甲" }, { name: "希望納期", value: "2026-10-02" }]
  });
  assert.deepEqual(
    [f.kind, f.counterpartyName, f.dueOn, f.requesterSlackId, f.requesterName],
    ["outsourcing", "株式会社甲", "2026-10-02", "U1", "山本"]);
  assert.equal(fromIssue({ id: 2, issueKey: "LEGAL-10", dueDate: "2026-10-31T00:00:00Z" }).dueOn, "2026-10-31");
  assert.equal(fromIssue({ id: 3, issueKey: "LEGAL-11", summary: "  " }).title, "LEGAL-11", "件名が無ければ課題キー");
});
