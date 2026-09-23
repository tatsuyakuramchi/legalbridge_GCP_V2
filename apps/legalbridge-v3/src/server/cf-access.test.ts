import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { AccessVerifier, accessTokenOf } from "./cf-access.js";

const TEAM = "arclight-lb.cloudflareaccess.com";
const AUD = "aud-tag-123";
const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);

const pair = () => generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwkOf = (kid: string, key: ReturnType<typeof pair>) =>
  ({ kid, kty: "RSA", alg: "RS256", ...(key.publicKey.export({ format: "jwk" }) as { n: string; e: string }) });
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

function token(key: ReturnType<typeof pair>, kid: string, over: Record<string, unknown> = {}) {
  const h = b64({ alg: "RS256", kid, typ: "JWT" });
  const p = b64({ aud: [AUD], iss: `https://${TEAM}`, exp: NOW / 1000 + 600, email: "Asai@Arclight.co.jp", ...over });
  const s = sign("RSA-SHA256", Buffer.from(`${h}.${p}`), key.privateKey).toString("base64url");
  return `${h}.${p}.${s}`;
}

function verifier(keys: Array<{ kid: string; key: ReturnType<typeof pair> }>, calls = { n: 0 }) {
  return new AccessVerifier({ teamDomain: TEAM, audience: AUD }, async (url) => {
    calls.n += 1;
    assert.equal(url, `https://${TEAM}/cdn-cgi/access/certs`);
    return { ok: true, status: 200, json: async () => ({ keys: keys.map((k) => jwkOf(k.kid, k.key)) }) };
  }, () => NOW);
}

test("正しいトークンならメールを小文字で返す", async () => {
  const k = pair();
  assert.equal(await verifier([{ kid: "k1", key: k }]).verify(token(k, "k1")), "asai@arclight.co.jp");
});

test("宛先・発行元・期限・署名のどれかが違えば通さない", async () => {
  const k = pair(); const other = pair();
  const v = verifier([{ kid: "k1", key: k }]);
  await assert.rejects(v.verify(token(k, "k1", { aud: ["someone-else"] })), /このアプリ宛て/);
  await assert.rejects(v.verify(token(k, "k1", { iss: "https://evil.cloudflareaccess.com" })), /発行元/);
  await assert.rejects(v.verify(token(k, "k1", { exp: NOW / 1000 - 3600 })), /期限/);
  await assert.rejects(v.verify(token(other, "k1")), /署名/);
  await assert.rejects(v.verify("abc"), /形/);
  await assert.rejects(v.verify(token(k, "k1", { email: "" })), /メール/);
});

test("知らない鍵 ID が来たら 1 回だけ鍵を取り直す（鍵の入れ替えに追従）", async () => {
  const k1 = pair(); const k2 = pair();
  const keys = [{ kid: "k1", key: k1 }];
  const calls = { n: 0 };
  const v = verifier(keys, calls);
  await v.verify(token(k1, "k1"));
  keys.push({ kid: "k2", key: k2 });
  assert.equal(await v.verify(token(k2, "k2")), "asai@arclight.co.jp");
  assert.equal(calls.n, 2);
  await assert.rejects(v.verify(token(k2, "k9")), /知らない鍵/);
});

test("チームのドメインか AUD が空なら起動時に止める", () => {
  assert.throws(() => new AccessVerifier({ teamDomain: "", audience: AUD }), /CF_ACCESS_TEAM_DOMAIN/);
});

test("トークンはヘッダが無ければ CF_Authorization クッキーから取る", () => {
  assert.equal(accessTokenOf("h.t.s", "CF_Authorization=c.o.k"), "h.t.s");
  assert.equal(accessTokenOf(undefined, "a=1; CF_Authorization=c.o.k; b=2"), "c.o.k");
  assert.equal(accessTokenOf(undefined, "a=1"), "");
});

test("認証の中間処理：Cloudflare のトークンを検証し、メールから役割を決める", async () => {
  const { config } = await import("./config.js");
  const { authenticate, setAccessVerifierForTest } = await import("./auth.js");
  const k = pair();
  const saved = { ...config };
  Object.assign(config, { authMode: "cloudflare", adminEmails: ["asai@arclight.co.jp"], legalEmails: [], requesterDomains: ["arclight.co.jp"] });
  setAccessVerifierForTest(verifier([{ kid: "k1", key: k }]));
  const run = (headers: Record<string, string>, path = "/matters") => new Promise<{ status: number; body?: unknown; user?: unknown }>((resolve) => {
    const req = { path, header: (n: string) => headers[n.toLowerCase()] } as never;
    const locals: Record<string, unknown> = {};
    const res = { locals, status(code: number) { return { json: (body: unknown) => resolve({ status: code, body }) }; } } as never;
    authenticate(req, res, (err?: unknown) => resolve({ status: err ? 500 : 200, user: locals.currentUser }));
  });
  try {
    const ok = await run({ "cf-access-jwt-assertion": token(k, "k1") });
    assert.deepEqual(ok, { status: 200, user: { email: "asai@arclight.co.jp", role: "admin", source: "cloudflare" } });
    const staff = await run({ "cf-access-jwt-assertion": token(k, "k1", { email: "yamada@arclight.co.jp" }) });
    assert.equal((staff.user as { role: string }).role, "requester");
    const outsider = await run({ "cf-access-jwt-assertion": token(k, "k1", { email: "x@example.com" }) });
    assert.equal(outsider.status, 403);
    // メールのヘッダだけ（トークン無し）は通さない。
    assert.equal((await run({ "cf-access-authenticated-user-email": "asai@arclight.co.jp" })).status, 401);
    assert.equal((await run({ "cf-access-jwt-assertion": "a.b.c" })).status, 401);
    assert.equal((await run({}, "/health")).status, 200, "/health は通す");
  } finally {
    Object.assign(config, saved);
    setAccessVerifierForTest(null);
  }
});
