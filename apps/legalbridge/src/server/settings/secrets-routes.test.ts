import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createSecretsRouter } from "./secrets-routes.js";
import { MemorySecretStore } from "./secret-store.js";

// APIキー投入API（Phase 2-5）。書き込み専用・Secret Manager のみ・admin ゲートの検証。

function appFor(opts: { enabled?: boolean; role?: string; store?: MemorySecretStore | null; onSaved?: () => void } = {}) {
  const store = opts.store === null ? undefined : opts.store ?? new MemorySecretStore();
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.currentUser = { email: "u@arclight.co.jp", subject: "t", role: opts.role ?? "admin", source: "test" } as never;
    next();
  });
  app.use("/api/v2", createSecretsRouter(store, opts.enabled ?? true, opts.onSaved));
  return { app, store };
}

test("secrets: admin 以外は403", async () => {
  assert.equal((await request(appFor({ role: "legal" }).app).get("/api/v2/settings/secrets")).status, 403);
  assert.equal((await request(appFor({ role: "legal" }).app)
    .post("/api/v2/settings/secrets").send({ secrets: { BACKLOG_API_KEY: "x".repeat(20) } })).status, 403);
});

test("secrets: GET は登録状況のみ返す（値は返さない）", async () => {
  const store = new MemorySecretStore();
  await store.addVersion("backlog-api-key", "super-secret-value");
  const res = await request(appFor({ store }).app).get("/api/v2/settings/secrets").expect(200);
  assert.equal(res.body.available, true);
  assert.equal(res.body.statuses.BACKLOG_API_KEY.registered, true);
  assert.equal(res.body.statuses.BACKLOG_API_KEY.version, "1");
  assert.equal(res.body.statuses.SLACK_BOT_TOKEN.registered, false);
  // 応答のどこにも値が漏れていないこと。
  assert.ok(!JSON.stringify(res.body).includes("super-secret-value"));
  // 表示用フィールド定義（allowlist）が返ること。
  assert.ok(res.body.fields.some((f: { key: string }) => f.key === "CLOUDSIGN_CLIENT_ID"));
});

test("secrets: ストア未設定は available=false（閲覧のみ）", async () => {
  const res = await request(appFor({ store: null }).app).get("/api/v2/settings/secrets").expect(200);
  assert.equal(res.body.available, false);
  assert.equal(res.body.writeEnabled, false);
});

test("secrets: 書込無効時は503", async () => {
  const res = await request(appFor({ enabled: false }).app)
    .post("/api/v2/settings/secrets").send({ secrets: { BACKLOG_API_KEY: "x".repeat(20) } });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "SECRETS_WRITE_UNAVAILABLE");
});

test("secrets: allowlist 外キーは400（何も保存しない）", async () => {
  const target = appFor({});
  const res = await request(target.app).post("/api/v2/settings/secrets")
    .send({ secrets: { BACKLOG_API_KEY: "x".repeat(20), DB_PASSWORD: "evil" } });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "SECRETS_KEY_NOT_ALLOWED");
  assert.equal(await target.store!.access("backlog-api-key"), null);
});

test("secrets: 形式チェック（xoxb-）に合わない値は400", async () => {
  const res = await request(appFor({}).app).post("/api/v2/settings/secrets")
    .send({ secrets: { SLACK_BOT_TOKEN: "not-a-slack-token" } });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "SECRETS_VALUE_INVALID");
});

test("secrets: 保存で Secret Manager に版が追加され onSaved が呼ばれる（値は応答に出ない）", async () => {
  let refreshed = 0;
  const target = appFor({ onSaved: () => { refreshed += 1; } });
  const res = await request(target.app).post("/api/v2/settings/secrets")
    .send({ secrets: { SLACK_BOT_TOKEN: "xoxb-123-abc", BACKLOG_API_KEY: "backlog-key-value-123" } })
    .expect(200);
  assert.equal(res.body.saved, 2);
  assert.equal(res.body.results.SLACK_BOT_TOKEN.ok, true);
  assert.ok(!JSON.stringify(res.body).includes("xoxb-123-abc"));
  assert.equal(await target.store!.access("SLACK_BOT_TOKEN"), "xoxb-123-abc");
  assert.equal(await target.store!.access("backlog-api-key"), "backlog-key-value-123");
  assert.equal(refreshed, 1);
});

test("secrets: 未作成シークレット（権限モデル上作成不可）は 207 で個別エラー", async () => {
  const store = new MemorySecretStore({ requireExisting: true });
  store.create("backlog-api-key");
  const target = appFor({ store });
  const res = await request(target.app).post("/api/v2/settings/secrets")
    .send({ secrets: { BACKLOG_API_KEY: "backlog-key-value-123", CLOUDSIGN_WEBHOOK_TOKEN: "token-value-123" } });
  assert.equal(res.status, 207);
  assert.equal(res.body.saved, 1);
  assert.equal(res.body.results.BACKLOG_API_KEY.ok, true);
  assert.equal(res.body.results.CLOUDSIGN_WEBHOOK_TOKEN.ok, false);
  assert.ok(String(res.body.results.CLOUDSIGN_WEBHOOK_TOKEN.error).includes("未作成"));
});
