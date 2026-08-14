import assert from "node:assert/strict";
import test from "node:test";
import {
  SlackWebApiConversationReader, DisabledSlackConversationReader,
  SlackConversationReadError
} from "./slack-conversation-reader.js";
import { SlackWebApiError, type SlackWebApiMethod } from "./slack-web-api-adapter.js";

function client(handler: (method: string, body: Record<string, unknown>) => unknown) {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  return {
    calls,
    post: async (method: SlackWebApiMethod, body: Record<string, unknown>) => {
      calls.push({ method, body });
      return handler(method, body);
    }
  };
}

const thread = {
  messages: [
    { ts: "1785580000.000100", bot_id: "B1", text: "法務依頼を受け付けました", blocks: [{ type: "header" }] },
    { ts: "1785580500.000200", user: "U0ABC123", text: "確認しました" }
  ]
};

test("conversations.replies を channel/ts 指定で呼び、正規化して返す", async () => {
  const api = client(() => thread);
  const reader = new SlackWebApiConversationReader(api, "U0BOT0001");
  const result = await reader.getThread("D0123456789", "1785580000.000100");

  assert.equal(api.calls[0].method, "conversations.replies");
  assert.equal(api.calls[0].body.channel, "D0123456789");
  assert.equal(api.calls[0].body.ts, "1785580000.000100");
  assert.deepEqual(result.messages, [
    { ts: "1785580000.000100", authorType: "legalbridge", authorId: "B1",
      text: "法務依頼を受け付けました", isRoot: true },
    { ts: "1785580500.000200", authorType: "user", authorId: "U0ABC123",
      text: "確認しました", isRoot: false }
  ]);
  // raw payload（blocks）は返さない。
  assert.ok(!JSON.stringify(result).includes("blocks"));
});

test("bot user ID 一致の発言も legalbridge 扱いにする", async () => {
  const api = client(() => ({ messages: [{ ts: "1.1", user: "U0BOT0001", text: "x" }] }));
  const reader = new SlackWebApiConversationReader(api, "U0BOT0001");
  const result = await reader.getThread("D0123456789", "1.1");
  assert.equal(result.messages[0].authorType, "legalbridge");
});

test("Slack エラーを理由コード付きの型付きエラーへ変換する", async () => {
  const cases: Array<[string, number | null, string]> = [
    ["ratelimited", null, "rate_limited"],
    ["http_error", 429, "rate_limited"],
    ["missing_scope", null, "missing_scope"],
    ["channel_not_found", null, "not_found"],
    ["something_else", null, "unavailable"]
  ];
  for (const [code, status, reason] of cases) {
    const api = client(() => { throw new SlackWebApiError("boom", code, status); });
    const reader = new SlackWebApiConversationReader(api);
    await assert.rejects(
      () => reader.getThread("D0123456789", "1785580000.000100"),
      (error: unknown) => error instanceof SlackConversationReadError && error.reason === reason);
  }
});

test("不正な channel / ts は Slack を呼ばずに拒否する", async () => {
  const api = client(() => thread);
  const reader = new SlackWebApiConversationReader(api);
  for (const [channel, ts] of [["bad", "1785580000.000100"], ["D0123456789", "not-a-ts"]]) {
    await assert.rejects(
      () => reader.getThread(channel, ts),
      (error: unknown) => error instanceof SlackConversationReadError &&
        error.reason === "invalid_anchor");
  }
  assert.equal(api.calls.length, 0);
});

test("ts が不正なメッセージは除外する", async () => {
  const api = client(() => ({ messages: [{ ts: "bad", text: "x" }, { ts: "1.1", text: "ok" }] }));
  const reader = new SlackWebApiConversationReader(api);
  const result = await reader.getThread("D0123456789", "1.1");
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].text, "ok");
});

test("読取無効アダプタは configured=false で常に失敗する", async () => {
  const reader = new DisabledSlackConversationReader();
  assert.equal(reader.configured, false);
  await assert.rejects(() => reader.getThread(),
    (error: unknown) => error instanceof SlackConversationReadError);
});
