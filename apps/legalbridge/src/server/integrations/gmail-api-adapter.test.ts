import assert from "node:assert/strict";
import test from "node:test";
import { KeylessGmailApiClient, GmailApiError, MEDIA_UPLOAD_THRESHOLD } from "./gmail-api-adapter.js";

// 鍵レス送信（signJwt → JWT-bearer 交換 → messages.send）の呼び出し列を検証する。
// V1 EmailService の鍵レス経路の移植。実ネットワークには出ない（fetch スタブ）。

type Call = { url: string; init: RequestInit };

function stubFetch(responses: Record<string, { status: number; body: unknown }>, calls: Call[]) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const matched = Object.entries(responses).find(([prefix]) => url.startsWith(prefix));
    if (!matched) throw new Error(`unexpected fetch: ${url}`);
    const { status, body } = matched[1];
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body)
    } as Response;
  }) as typeof fetch;
}

const DELEGATE = "988056987352-compute@developer.gserviceaccount.com";

test("keyless: signJwt→トークン交換→送信の順で呼び、委任クレームが正しい", async () => {
  const calls: Call[] = [];
  const client = new KeylessGmailApiClient("tatsuya@example.co.jp", DELEGATE, stubFetch({
    "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/":
      { status: 200, body: { signedJwt: "signed-jwt" } },
    "https://oauth2.googleapis.com/token":
      { status: 200, body: { access_token: "delegated-token" } },
    "https://gmail.googleapis.com/gmail/v1/users/":
      { status: 200, body: { id: "m1", threadId: "t1" } }
  }, calls), async () => "base-token");

  const receipt = await client.send("tatsuya@example.co.jp", "cmF3", "key");
  assert.deepEqual(receipt, { id: "m1", threadId: "t1" });
  assert.equal(calls.length, 3);

  // signJwt: 委任先SAのエンドポイント＋ベーストークン＋クレーム（iss=SA / sub=送信元 / gmail.send）
  assert.ok(calls[0].url.includes(encodeURIComponent(DELEGATE)));
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer base-token");
  const claims = JSON.parse(JSON.parse(String(calls[0].init.body)).payload);
  assert.equal(claims.iss, DELEGATE);
  assert.equal(claims.sub, "tatsuya@example.co.jp");
  assert.equal(claims.scope, "https://www.googleapis.com/auth/gmail.send");

  // トークン交換: jwt-bearer
  const form = String(calls[1].init.body);
  assert.ok(form.includes("jwt-bearer") && form.includes("assertion=signed-jwt"));

  // 送信: 交換後トークンで JSON エンドポイント
  assert.equal((calls[2].init.headers as Record<string, string>).Authorization, "Bearer delegated-token");
  assert.equal(JSON.parse(String(calls[2].init.body)).raw, "cmF3");
});

test("keyless: 大きい raw はメディアアップロードで送る", async () => {
  const calls: Call[] = [];
  const client = new KeylessGmailApiClient("a@x.jp", DELEGATE, stubFetch({
    "https://iamcredentials.googleapis.com/": { status: 200, body: { signedJwt: "s" } },
    "https://oauth2.googleapis.com/token": { status: 200, body: { access_token: "t" } },
    "https://gmail.googleapis.com/upload/gmail/v1/users/": { status: 200, body: { id: "m2", threadId: null } }
  }, calls), async () => "base");
  const bigRaw = "A".repeat(MEDIA_UPLOAD_THRESHOLD + 10);
  const receipt = await client.send("a@x.jp", bigRaw, "key");
  assert.equal(receipt.id, "m2");
  assert.ok(calls[2].url.includes("uploadType=media"));
  assert.equal((calls[2].init.headers as Record<string, string>)["Content-Type"], "message/rfc822");
});

test("keyless: signJwt 失敗は tokenCreator の案内つきで失敗する", async () => {
  const client = new KeylessGmailApiClient("a@x.jp", DELEGATE, stubFetch({
    "https://iamcredentials.googleapis.com/":
      { status: 403, body: { error: { message: "Permission iam.serviceAccounts.signJwt denied" } } }
  }, []), async () => "base");
  await assert.rejects(client.send("a@x.jp", "cmF3", "k"), (error: unknown) => {
    assert.ok(error instanceof GmailApiError);
    assert.match(error.message, /signJwt failed: 403/);
    assert.match(error.message, /serviceAccountTokenCreator/);
    return true;
  });
});

test("keyless: トークン交換失敗はドメイン全体委任の案内つきで失敗する", async () => {
  const client = new KeylessGmailApiClient("a@x.jp", DELEGATE, stubFetch({
    "https://iamcredentials.googleapis.com/": { status: 200, body: { signedJwt: "s" } },
    "https://oauth2.googleapis.com/token":
      { status: 401, body: { error: "unauthorized_client", error_description: "Client is unauthorized" } }
  }, []), async () => "base");
  await assert.rejects(client.send("a@x.jp", "cmF3", "k"), (error: unknown) => {
    assert.ok(error instanceof GmailApiError);
    assert.match(error.message, /unauthorized_client/);
    assert.match(error.message, /ドメイン全体委任/);
    return true;
  });
});

test("keyless: 委任SA未指定でメタデータも引けなければ設定案内で失敗する", async () => {
  const client = new KeylessGmailApiClient("a@x.jp", "", (async () => {
    throw new Error("no metadata server");
  }) as unknown as typeof fetch, async () => "base");
  await assert.rejects(client.send("a@x.jp", "cmF3", "k"), (error: unknown) => {
    assert.ok(error instanceof GmailApiError);
    assert.match(error.message, /GMAIL_DELEGATE_SA/);
    return true;
  });
});
