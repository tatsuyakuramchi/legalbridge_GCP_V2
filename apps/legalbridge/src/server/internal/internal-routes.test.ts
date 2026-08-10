import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createJobsRouter } from "./jobs-routes.js";
import { createWebhooksRouter } from "./webhooks-routes.js";
import { tokensMatch, extractPresentedToken } from "./shared-secret.js";

const TOKEN = "s3cr3t-token-value";

function jobsApp(opts: Parameters<typeof createJobsRouter>[0]) {
  const app = express();
  app.use(express.json());
  app.use(createJobsRouter(opts));
  return app;
}

test("tokensMatch: 一致/不一致/空", () => {
  assert.equal(tokensMatch(TOKEN, TOKEN), true);
  assert.equal(tokensMatch(TOKEN, "wrong-len"), false);
  assert.equal(tokensMatch(TOKEN, TOKEN.slice(0, -1) + "X"), false);
  assert.equal(tokensMatch("", ""), false);      // 未設定は常に不一致
  assert.equal(tokensMatch(undefined, "x"), false);
});

test("extractPresentedToken: 直接ヘッダ優先・Bearer 対応", () => {
  assert.equal(extractPresentedToken("abc", undefined), "abc");
  assert.equal(extractPresentedToken(undefined, "Bearer xyz"), "xyz");
  assert.equal(extractPresentedToken(undefined, "bearer  yz "), "yz");
  assert.equal(extractPresentedToken(undefined, undefined), null);
});

test("jobs: 無効時は404（存在秘匿）", async () => {
  const app = jobsApp({ enabled: false, token: TOKEN, runners: { ping: async () => "pong" } });
  const res = await request(app).post("/internal/jobs/ping").set("x-jobs-token", TOKEN);
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "JOBS_DISABLED");
});

test("jobs: トークン不一致は401", async () => {
  const app = jobsApp({ enabled: true, token: TOKEN, runners: { ping: async () => "pong" } });
  const res = await request(app).post("/internal/jobs/ping").set("x-jobs-token", "nope");
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "JOBS_UNAUTHORIZED");
});

test("jobs: 未知ジョブは404", async () => {
  const app = jobsApp({ enabled: true, token: TOKEN, runners: {} });
  const res = await request(app).post("/internal/jobs/unknown").set("Authorization", `Bearer ${TOKEN}`);
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "JOB_NOT_FOUND");
});

test("jobs: 正常実行は結果を返す", async () => {
  let ran = 0;
  const app = jobsApp({ enabled: true, token: TOKEN, runners: { ping: async () => { ran++; return { n: 42 }; } } });
  const res = await request(app).post("/internal/jobs/ping").set("x-jobs-token", TOKEN);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.result.n, 42);
  assert.equal(ran, 1);
});

test("jobs: runner 例外は500", async () => {
  const app = jobsApp({ enabled: true, token: TOKEN, runners: { boom: async () => { throw new Error("kaboom"); } } });
  const res = await request(app).post("/internal/jobs/boom").set("x-jobs-token", TOKEN);
  assert.equal(res.status, 500);
  assert.equal(res.body.code, "JOB_FAILED");
  assert.equal(res.body.error, "kaboom");
});

function webhookApp(opts: Parameters<typeof createWebhooksRouter>[0]) {
  const app = express();
  app.use(express.json());
  app.use(createWebhooksRouter(opts));
  return app;
}

test("webhook: token/handler 未設定は404", async () => {
  const app = webhookApp({ cloudsign: { token: TOKEN } }); // handler 無し
  const res = await request(app).post("/internal/webhooks/cloudsign").set("x-webhook-token", TOKEN).send({});
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "WEBHOOK_DISABLED");
});

test("webhook: トークン不一致は401", async () => {
  const app = webhookApp({ cloudsign: { token: TOKEN, handler: async () => ({ body: { ok: true } }) } });
  const res = await request(app).post("/internal/webhooks/cloudsign").set("x-webhook-token", "nope").send({});
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "WEBHOOK_UNAUTHORIZED");
});

test("webhook: 正常受信は handler の結果を返す", async () => {
  let seen: unknown = null;
  const app = webhookApp({ backlog: { token: TOKEN, handler: async (payload) => { seen = payload; return { status: 202, body: { accepted: true } }; } } });
  const res = await request(app).post("/internal/webhooks/backlog").set("Authorization", `Bearer ${TOKEN}`).send({ type: 1 });
  assert.equal(res.status, 202);
  assert.equal(res.body.accepted, true);
  assert.deepEqual(seen, { type: 1 });
});
