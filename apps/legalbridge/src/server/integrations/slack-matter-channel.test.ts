import assert from "node:assert/strict";
import test from "node:test";
import {
  mentionTokens, composeMentionMessage, buildThreadRootText, isSlackUserId
} from "./slack-matter-channel.js";

test("isSlackUserId は U/W 始まりの有効IDのみ真", () => {
  assert.equal(isSlackUserId("U01ABCDEFGH"), true);
  assert.equal(isSlackUserId("W01ABCDEFGH"), true);
  assert.equal(isSlackUserId("D01ABCDEFGH"), false); // DMチャンネルはユーザーIDでない
  assert.equal(isSlackUserId("notanid"), false);
});

test("mentionTokens は有効IDを <@id> にし無効は除外する", () => {
  assert.deepEqual(
    mentionTokens(["U01ABCDEFGH", "bad", " W02ABCDEFGH "]),
    ["<@U01ABCDEFGH>", "<@W02ABCDEFGH>"]
  );
});

test("composeMentionMessage は本文＋メンション（＋末尾）を組み立てる", () => {
  const text = composeMentionMessage("文書作成が完了しました。", ["U01ABCDEFGH", "U02ABCDEFGH"], {
    trailing: "閲覧リンク: https://drive.example/x"
  });
  assert.match(text, /^文書作成が完了しました。 <@U01ABCDEFGH> <@U02ABCDEFGH>/);
  assert.match(text, /\n閲覧リンク: https:\/\/drive\.example\/x$/);
});

test("composeMentionMessage はメンション無しなら本文のみ", () => {
  assert.equal(composeMentionMessage("送信しました。", []), "送信しました。");
});

test("buildThreadRootText は matter_code か #id と相手方を含む", () => {
  const withCode = buildThreadRootText({ matterCode: "MTR-2026-00001", matterId: 5, title: "契約", counterparty: "株式会社甲" });
  assert.match(withCode, /法務相談スレッド MTR-2026-00001/);
  assert.match(withCode, /相手方: 株式会社甲/);
  const noCode = buildThreadRootText({ matterCode: null, matterId: 5, title: "契約", counterparty: "" });
  assert.match(noCode, /#5/);
  assert.doesNotMatch(noCode, /相手方/);
});
