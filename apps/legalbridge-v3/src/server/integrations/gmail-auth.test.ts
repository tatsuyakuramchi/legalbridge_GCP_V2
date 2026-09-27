import test from "node:test";
import assert from "node:assert/strict";
import { delegatedToken, GMAIL_SEND_SCOPE } from "./gmail-auth.js";

/** メタデータ・signJwt・トークン交換を手元で返す。何を送ったかを残す。 */
function fakeFetch(opts: { exchange?: { status: number; body: any } } = {}) {
  const calls: Array<{ url: string; body?: string }> = [];
  const impl = (async (url: string, init?: any) => {
    calls.push({ url, body: init?.body });
    const json = (status: number, body: any) => new Response(JSON.stringify(body), { status });
    if (url.endsWith("/default/email")) return new Response("runtime@p.iam.gserviceaccount.com");
    if (url.endsWith("/default/token")) return json(200, { access_token: "meta" });
    if (url.includes(":signJwt")) return json(200, { signedJwt: "signed.jwt" });
    if (url.includes("oauth2.googleapis.com/token")) {
      const e = opts.exchange ?? { status: 200, body: { access_token: "gmail-token" } };
      return json(e.status, e.body);
    }
    return json(404, {});
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("鍵なしで、送信元を sub にした JWT を署名して交換する", async () => {
  const f = fakeFetch();
  const token = await delegatedToken({ sender: "legal@example.com", scope: GMAIL_SEND_SCOPE, fetchImpl: f.impl })();
  assert.equal(token, "gmail-token");
  const sign = f.calls.find((c) => c.url.includes(":signJwt"))!;
  assert.match(sign.url, /runtime%40p\.iam\.gserviceaccount\.com:signJwt/);
  const claims = JSON.parse(JSON.parse(sign.body!).payload);
  assert.equal(claims.sub, "legal@example.com");
  assert.equal(claims.scope, GMAIL_SEND_SCOPE, "スコープは用途のものだけ（委任に無いものを混ぜない）");
});

test("署名する SA を指定できる（V1 で委任済みの SA を使う）", async () => {
  const f = fakeFetch();
  await delegatedToken({ sender: "legal@example.com", scope: GMAIL_SEND_SCOPE,
                         delegationSa: "v1-worker@p.iam.gserviceaccount.com", fetchImpl: f.impl })();
  assert.ok(f.calls.some((c) => c.url.includes("v1-worker%40p.iam.gserviceaccount.com:signJwt")));
  assert.ok(!f.calls.some((c) => c.url.endsWith("/default/email")));
});

test("50 分は取り直さない", async () => {
  const f = fakeFetch();
  let t = 0;
  const get = delegatedToken({ sender: "a@example.com", scope: GMAIL_SEND_SCOPE, fetchImpl: f.impl, now: () => t });
  await get(); t = 49 * 60 * 1000; await get();
  assert.equal(f.calls.filter((c) => c.url.includes(":signJwt")).length, 1);
  t = 51 * 60 * 1000; await get();
  assert.equal(f.calls.filter((c) => c.url.includes(":signJwt")).length, 2);
});

test("委任が無ければ、理由の分かる言葉で止める", async () => {
  const f = fakeFetch({ exchange: { status: 401, body: { error: "unauthorized_client", error_description: "Client is unauthorized" } } });
  await assert.rejects(
    delegatedToken({ sender: "a@example.com", scope: GMAIL_SEND_SCOPE, fetchImpl: f.impl })(),
    /ドメイン全体委任.*unauthorized_client/);
});

test("送信元が無ければ呼ばない", async () => {
  const f = fakeFetch();
  await assert.rejects(delegatedToken({ sender: "", scope: GMAIL_SEND_SCOPE, fetchImpl: f.impl })(), /GMAIL_SENDER/);
  assert.equal(f.calls.length, 0);
});
