import test from "node:test";
import assert from "node:assert/strict";
import { BUSINESS_LINES, composeMatterTitle } from "./title.js";

test("事業区分の増設（A-050）：出版事業・ボードゲーム事業・イベント事業も件名に組める", () => {
  assert.equal(composeMatterTitle({ kind: "outsourcing", businessLine: "publishing", partyName: "編集プロダクション", businessName: "第4巻 編集" }),
    "出版事業｜編集プロダクション｜第4巻 編集");
  assert.equal(composeMatterTitle({ kind: "outsourcing", businessLine: "event", partyName: "イベント社", businessName: "ゲームマーケット設営" }),
    "イベント事業｜イベント社｜ゲームマーケット設営");
  assert.equal(composeMatterTitle({ kind: "outsourcing", businessLine: "store", partyName: "A社", businessName: "清掃" }), "店舗事業｜A社｜清掃");
  assert.deepEqual(BUSINESS_LINES.map((b) => b.value), ["publishing", "boardgame", "event", "store", "admin", "other"]);
});
