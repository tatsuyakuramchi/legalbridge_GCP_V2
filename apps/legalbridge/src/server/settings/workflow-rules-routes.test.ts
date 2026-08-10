import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createWorkflowRulesRouter } from "./workflow-rules-routes.js";
import { MemoryWorkflowRulesRepository, type WorkflowRule } from "./workflow-rules-repository.js";

function appFor(opts: { enabled?: boolean; role?: string; forbidden?: boolean; seed?: WorkflowRule[] } = {}) {
  const repository = new MemoryWorkflowRulesRepository(opts.seed ?? [
    { department: "法務部", approverSlackId: "U0000000001", stampOperatorSlackId: null, managerSlackId: null, slackChannelId: "C0000000001", isActive: true }
  ], opts.forbidden ?? false);
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.currentUser = { email: "u@arclight.co.jp", subject: "t", role: opts.role ?? "admin", source: "test" } as never;
    next();
  });
  app.use("/api/v2", createWorkflowRulesRouter(repository, opts.enabled ?? false));
  return { app, repository };
}

test("承認ルート: admin 以外は403（読取）", async () => {
  const res = await request(appFor({ role: "legal" }).app).get("/api/v2/workflow-rules");
  assert.equal(res.status, 403);
});

test("承認ルート: 一覧を返す", async () => {
  const res = await request(appFor({ enabled: false }).app).get("/api/v2/workflow-rules").expect(200);
  assert.equal(res.body.rules.length, 1);
  assert.equal(res.body.rules[0].department, "法務部");
  assert.equal(res.body.writeEnabled, false);
});

test("承認ルート: 書込無効時は503", async () => {
  const res = await request(appFor({ enabled: false }).app)
    .post("/api/v2/workflow-rules").send({ department: "営業部" });
  assert.equal(res.status, 503);
});

test("承認ルート: upsert して部門一意で反映", async () => {
  const target = appFor({ enabled: true });
  const created = await request(target.app).post("/api/v2/workflow-rules")
    .send({ department: "営業部", approverSlackId: "U0000000002", slackChannelId: "C0000000002" }).expect(200);
  assert.equal(created.body.rule.department, "営業部");
  // 同部門を再 upsert（更新）
  await request(target.app).post("/api/v2/workflow-rules")
    .send({ department: "営業部", approverSlackId: "U0000000099", isActive: false }).expect(200);
  const list = await request(target.app).get("/api/v2/workflow-rules").expect(200);
  const sales = list.body.rules.find((r: { department: string }) => r.department === "営業部");
  assert.equal(sales.approverSlackId, "U0000000099");
  assert.equal(sales.isActive, false);
  assert.equal(list.body.rules.length, 2);   // 法務部＋営業部（重複しない）
});

test("承認ルート: 不正な Slack ID は400", async () => {
  const res = await request(appFor({ enabled: true }).app)
    .post("/api/v2/workflow-rules").send({ department: "X", approverSlackId: "not-a-slack-id" });
  assert.equal(res.status, 400);
});

test("承認ルート: 部門空は400", async () => {
  const res = await request(appFor({ enabled: true }).app).post("/api/v2/workflow-rules").send({ department: "" });
  assert.equal(res.status, 400);
});

test("承認ルート: 権限未整備(FORBIDDEN_DB)は503", async () => {
  const res = await request(appFor({ enabled: true, forbidden: true }).app)
    .post("/api/v2/workflow-rules").send({ department: "総務部" });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "WORKFLOW_RULES_FORBIDDEN_DB");
});
