import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GoogleLogin, friendlyGoogleAuthError } from "./google-login.js";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "glogin-")), "sub", "google-login.json");
const idToken = (email: string) => `h.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.s`;

function fakeFetch(token: Record<string, unknown> = { access_token: "at", refresh_token: "rt", id_token: idToken("me@example.com") }, status = 200) {
  const calls: Array<{ url: string; body: string }> = [];
  const impl = (async (url: string, init?: any) => {
    calls.push({ url, body: String(init?.body ?? "") });
    return new Response(JSON.stringify(token), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("始める：state を付けて Google へ。戻ってきたら state を照合してコードを替え、authorized_user で保存する", async () => {
  const file = tmp(); const f = fakeFetch();
  const login = new GoogleLogin({ clientId: "cid", clientSecret: "sec", path: file, fetchImpl: f.impl, randomState: () => "st1", now: () => 1_000 });
  assert.equal(login.configured, true);
  const { url, state } = login.start("http://localhost:8080/auth/google/callback");
  assert.equal(state, "st1");
  const u = new URL(url);
  assert.equal(u.searchParams.get("client_id"), "cid");
  assert.equal(u.searchParams.get("access_type"), "offline");
  assert.equal(u.searchParams.get("prompt"), "consent");
  assert.match(u.searchParams.get("scope")!, /cloud-platform/);

  const r = await login.finish({ code: "c0de", state: "st1", redirectUrl: "http://localhost:8080/auth/google/callback" });
  assert.equal(r.email, "me@example.com");
  assert.match(f.calls[0]!.body, /grant_type=authorization_code/);
  assert.match(f.calls[0]!.body, /code=c0de/);
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(stored.type, "authorized_user");
  assert.equal(stored.refresh_token, "rt");
  assert.equal(stored.email, "me@example.com");
  assert.equal(login.hasAppLogin(), true);
  const s = await login.status();
  assert.equal(s.source, "app"); assert.equal(s.email, "me@example.com");

  login.logout();
  assert.equal(login.hasAppLogin(), false);
  assert.equal((await login.status()).source, "none");
});

test("止める：知らない state、同じ state の使い回し、refresh_token なし", async () => {
  const file = tmp();
  const f = fakeFetch({ access_token: "at", id_token: idToken("x@example.com") });
  const login = new GoogleLogin({ clientId: "cid", clientSecret: "sec", path: file, fetchImpl: f.impl, randomState: () => "s" });
  await assert.rejects(login.finish({ code: "c", state: "nope", redirectUrl: "u" }), /古いか、別のところ/);
  login.start("u");
  await assert.rejects(login.finish({ code: "c", state: "s", redirectUrl: "u" }), /refresh_token を返しません/);
  await assert.rejects(login.finish({ code: "c", state: "s", redirectUrl: "u" }), /古いか/, "state は一度きり");
});

test("設定が無ければ configured=false で、始められない", () => {
  const login = new GoogleLogin({ clientId: "", clientSecret: "", path: tmp() });
  assert.equal(login.configured, false);
  assert.throws(() => login.start("u"), /設定されていません/);
});

test("切れたときの言い換え：invalid_rapt → ログインし直す", () => {
  const e = Object.assign(new Error("invalid_grant"), { response: { data: { error: "invalid_grant", error_subtype: "invalid_rapt" } } });
  assert.match(friendlyGoogleAuthError(e).message, /ログインが切れています.*ログインし直す/);
  assert.match(friendlyGoogleAuthError(new Error("invalid_grant: Token has been revoked")).message, /無効になっています/);
  assert.equal(friendlyGoogleAuthError(new Error("other")).message, "other");
});

test("状態：ログインが無く ADC も無ければ none。確認は「ログインがありません」", async () => {
  const login = new GoogleLogin({ clientId: "cid", clientSecret: "sec", path: tmp(), adcPath: "" });
  const s = await login.status({ check: true });
  assert.equal(s.source, "none"); assert.equal(s.ok, false);
});
