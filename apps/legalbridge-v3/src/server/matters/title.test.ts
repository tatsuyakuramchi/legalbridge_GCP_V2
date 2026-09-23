import test from "node:test";
import assert from "node:assert/strict";
import { BUSINESS_LINES, composeMatterTitle } from "./title.js";

test("事業区分の増設（A-050）：出版事業・ボードゲーム事業・イベント事業も件名に組める", () => {
  assert.equal(composeMatterTitle({ kind: "outsourcing", businessLine: "publishing", partyName: "編集プロダクション", businessName: "第4巻 編集" }),
    "出版事業｜編集プロダクション｜第4巻 編集");
  assert.equal(composeMatterTitle({ kind: "outsourcing", businessLine: "planning", partyName: "イベント社", businessName: "ゲームマーケット設営" }),
    "企画事業｜イベント社｜ゲームマーケット設営");
  // 作品案件の件名は事業区分を入れない（作品名が軸）。
  assert.equal(composeMatterTitle({ kind: "work", workTitle: "星降る夜", production: true, businessLine: "publishing" }), "星降る夜｜制作＋許諾");
  assert.equal(composeMatterTitle({ kind: "outsourcing", businessLine: "store", partyName: "A社", businessName: "清掃" }), "店舗事業｜A社｜清掃");
  assert.deepEqual(BUSINESS_LINES.map((b) => b.label), ["店舗事業", "出版事業", "ボードゲーム事業", "企画事業", "管理事業部"]);
});
