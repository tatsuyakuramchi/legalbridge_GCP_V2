import assert from "node:assert/strict";
import test from "node:test";
import type { SlackDeliveryRequest } from "./slack-delivery-adapter.js";
import {
  FetchSlackWebApiClient,
  SlackWebApiDeliveryAdapter,
  SlackWebApiError,
  type SlackWebApiClient
} from "./slack-web-api-adapter.js";

const deliveryRequest: SlackDeliveryRequest = {
  userId: "U08217X0A07",
  idempotencyKey: "a".repeat(64),
  issueKey: "LEGAL-10",
  headline: "依頼者の確認が必要です",
  body: "法務部から確認事項または文書案があります。",
  nextAction: "内容を確認して回答してください。",
  actions: [{
    id: "confirm_request",
    label: "内容を確認",
    url: "https://legalbridge-v2-test.arclight.co.jp/documents/10",
    style: "primary"
  }]
};

class StubClient implements SlackWebApiClient {
  readonly calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  constructor(private readonly responses: unknown[]) {}
  async post(method: "conversations.open" | "chat.postMessage", body: Record<string, unknown>) {
    this.calls.push({ method, body });
    return this.responses.shift();
  }
}

test("DMを開いて現在地・次の行動・確認ボタンを送信する", async () => {
  const client = new StubClient([
    { ok: true, channel: { id: "D0123456789" } },
    { ok: true, channel: "D0123456789", ts: "1785580000.000100" }
  ]);
  const adapter = new SlackWebApiDeliveryAdapter(client);
  const receipt = await adapter.send(deliveryRequest);

  assert.deepEqual(receipt, {
    channelId: "D0123456789",
    messageTs: "1785580000.000100"
  });
  assert.equal(client.calls[0].method, "conversations.open");
  assert.equal(client.calls[0].body.users, "U08217X0A07");
  assert.equal(client.calls[1].method, "chat.postMessage");
  assert.equal(client.calls[1].body.channel, "D0123456789");
  assert.match(String(client.calls[1].body.client_msg_id), /^[a-f0-9-]{36}$/);
  assert.match(String(client.calls[1].body.text), /次の行動/);
  const blocks = client.calls[1].body.blocks as Array<Record<string, any>>;
  assert.equal(blocks[2].elements[0].text.includes("現在地"), true);
  assert.equal(blocks[3].elements[0].url, deliveryRequest.actions[0].url);
  assert.equal(blocks[3].elements[0].style, "primary");
});

test("DMチャンネル応答が不正ならメッセージを送信しない", async () => {
  const client = new StubClient([{ ok: true, channel: {} }]);
  const adapter = new SlackWebApiDeliveryAdapter(client);
  await assert.rejects(adapter.send(deliveryRequest), (error: unknown) =>
    error instanceof SlackWebApiError && error.code === "invalid_dm_channel"
  );
  assert.equal(client.calls.length, 1);
});

test("メッセージ応答のチャンネル不一致を成功扱いにしない", async () => {
  const client = new StubClient([
    { ok: true, channel: { id: "D0123456789" } },
    { ok: true, channel: "D9999999999", ts: "1785580000.000100" }
  ]);
  await assert.rejects(
    new SlackWebApiDeliveryAdapter(client).send(deliveryRequest),
    (error: unknown) =>
      error instanceof SlackWebApiError && error.code === "invalid_message_receipt"
  );
});

test("Bot TokenはAuthorizationヘッダーだけで送信する", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new FetchSlackWebApiClient(
    "xoxb-test-token",
    (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        ok: true,
        channel: { id: "D0123456789" }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch
  );
  await client.post("conversations.open", { users: "U08217X0A07" });
  assert.equal(calls.length, 1);
  assert.equal(
    (calls[0].init?.headers as Record<string, string>).Authorization,
    "Bearer xoxb-test-token"
  );
  assert.doesNotMatch(String(calls[0].init?.body), /xoxb-test-token/);
});

test("conversations.replies はGET＋クエリで呼ぶ（JSONボディはinvalid_argumentsになる）", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new FetchSlackWebApiClient(
    "xoxb-test-token",
    (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true, messages: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch
  );
  await client.post("conversations.replies", { channel: "C0123456789", ts: "1700000000.000100", limit: 200 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.method, "GET");
  assert.equal(calls[0].init?.body, undefined);
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get("channel"), "C0123456789");
  assert.equal(url.searchParams.get("ts"), "1700000000.000100");
  assert.equal(url.searchParams.get("limit"), "200");
  assert.equal(
    (calls[0].init?.headers as Record<string, string>).Authorization,
    "Bearer xoxb-test-token"
  );
});

test("Slackのok falseとHTTP制限を明示的なエラーにする", async () => {
  const apiErrorClient = new FetchSlackWebApiClient(
    "xoxb-test-token",
    (async () => new Response(JSON.stringify({
      ok: false,
      error: "missing_scope"
    }), { status: 200 })) as typeof fetch
  );
  await assert.rejects(
    apiErrorClient.post("conversations.open", { users: "U08217X0A07" }),
    (error: unknown) =>
      error instanceof SlackWebApiError && error.code === "missing_scope"
  );

  const limitedClient = new FetchSlackWebApiClient(
    "xoxb-test-token",
    (async () => new Response(JSON.stringify({
      ok: false,
      error: "ratelimited"
    }), {
      status: 429,
      headers: { "retry-after": "30" }
    })) as typeof fetch
  );
  await assert.rejects(
    limitedClient.post("chat.postMessage", { channel: "D0123456789", text: "test" }),
    (error: unknown) =>
      error instanceof SlackWebApiError &&
      error.status === 429 &&
      error.retryAfter === "30"
  );
});

test("不正なBot Token形式を初期化時に拒否する", () => {
  assert.throws(
    () => new FetchSlackWebApiClient("plain-secret"),
    /valid Slack bot token/
  );
});


test("不正な宛先と通知指紋はAPI呼出し前に拒否する", async () => {
  const client = new StubClient([]);
  await assert.rejects(
    new SlackWebApiDeliveryAdapter(client).send({
      ...deliveryRequest,
      userId: "invalid"
    }),
    /valid user ID/
  );
  await assert.rejects(
    new SlackWebApiDeliveryAdapter(client).send({
      ...deliveryRequest,
      idempotencyKey: "invalid"
    }),
    /SHA-256 fingerprint/
  );
  assert.deepEqual(client.calls, []);
});
