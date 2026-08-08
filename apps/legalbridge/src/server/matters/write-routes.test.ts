import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createMatterWriteRouter } from "./write-routes.js";
import { MemoryMatterWriteRepository } from "./write-repository.js";
import { NoopMatterSlackNotifier } from "./matter-slack-notifier.js";
import { MemoryMatterIssueWriteRepository } from "./matter-issue-write-repository.js";

function appFor(options: { enabled: boolean; role?: "admin" | "legal" | "requester" }) {
  const repository = new MemoryMatterWriteRepository();
  const issues = new MemoryMatterIssueWriteRepository();
  const app = express();
  app.use(express.json());
  app.use((_request, response, next) => {
    response.locals.currentUser = {
      email: "editor@arclight.co.jp",
      subject: "test",
      role: options.role ?? "admin",
      source: "disabled"
    };
    next();
  });
  app.use("/api/v2", createMatterWriteRouter(repository, options.enabled, new NoopMatterSlackNotifier(), issues));
  return { app, repository, issues };
}

test("案件検証は不正な本文を拒否する", async () => {
  const { app } = appFor({ enabled: true });
  const response = await request(app).post("/api/v2/matters/validate").send({ title: "" });
  assert.equal(response.status, 400);
  assert.equal(response.body.ok, false);
  assert.ok(response.body.errors.some((e: { field: string }) => e.field === "title"));
});

test("書込み無効時は案件作成を拒否する", async () => {
  const { app } = appFor({ enabled: false });
  const response = await request(app).post("/api/v2/matters").send({ title: "新案件" });
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "MATTER_WRITE_UNAVAILABLE");
});

test("依頼者ロールは案件を編集できない", async () => {
  const { app } = appFor({ enabled: true, role: "requester" });
  const response = await request(app).post("/api/v2/matters").send({ title: "新案件" });
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "MATTER_EDIT_FORBIDDEN");
});

test("案件を作成し自動採番の案件番号を返す", async () => {
  const { app } = appFor({ enabled: true });
  const response = await request(app).post("/api/v2/matters")
    .send({ title: "許諾案件A", counterparty: "取引先X", lifecycleStage: "drafting" });
  assert.equal(response.status, 201);
  assert.equal(typeof response.body.id, "number");
  assert.match(response.body.matterCode, /^MTR-\d{4}-\d{5}$/);
});

test("案件の不正な工程値を拒否する", async () => {
  const { app } = appFor({ enabled: true });
  const response = await request(app).post("/api/v2/matters")
    .send({ title: "案件", lifecycleStage: "not-a-stage" });
  assert.equal(response.status, 400);
});

test("存在しない案件の更新は404を返す", async () => {
  const { app } = appFor({ enabled: true });
  const response = await request(app).patch("/api/v2/matters/999").send({ status: "closed" });
  assert.equal(response.status, 404);
  assert.equal(response.body.code, "MATTER_NOT_FOUND");
});

test("案件フィールドを部分更新できる", async () => {
  const { app } = appFor({ enabled: true });
  const created = await request(app).post("/api/v2/matters").send({ title: "案件B" });
  const response = await request(app).patch(`/api/v2/matters/${created.body.id}`)
    .send({ status: "in_progress", blockedReason: "相手方回答待ち" });
  assert.equal(response.status, 200);
  assert.equal(response.body.id, created.body.id);
});

test("空の更新本文を拒否する", async () => {
  const { app } = appFor({ enabled: true });
  const created = await request(app).post("/api/v2/matters").send({ title: "案件C" });
  const response = await request(app).patch(`/api/v2/matters/${created.body.id}`).send({});
  assert.equal(response.status, 400);
});

test("案件にタスク（次アクション）を追加できる", async () => {
  const { app } = appFor({ enabled: true });
  const created = await request(app).post("/api/v2/matters").send({ title: "案件D" });
  const response = await request(app).post(`/api/v2/matters/${created.body.id}/tasks`)
    .send({ title: "ドラフト送付", isPrimary: true, status: "in_progress" });
  assert.equal(response.status, 201);
  assert.equal(response.body.isPrimary, true);
  assert.equal(response.body.matterId, created.body.id);
});

test("次アクションは案件につき1件に絞られる", async () => {
  const { app, repository } = appFor({ enabled: true });
  const created = await request(app).post("/api/v2/matters").send({ title: "案件E" });
  const matterId = created.body.id;
  await request(app).post(`/api/v2/matters/${matterId}/tasks`).send({ title: "旧次アクション", isPrimary: true });
  await request(app).post(`/api/v2/matters/${matterId}/tasks`).send({ title: "新次アクション", isPrimary: true });
  const primaries = [...repository.tasks.values()]
    .filter((task) => task.matterId === matterId && task.isPrimary);
  assert.equal(primaries.length, 1);
  assert.equal(primaries[0].title, "新次アクション");
});

test("存在しないタスクの更新は404を返す", async () => {
  const { app } = appFor({ enabled: true });
  const created = await request(app).post("/api/v2/matters").send({ title: "案件F" });
  const response = await request(app).patch(`/api/v2/matters/${created.body.id}/tasks/999`)
    .send({ status: "done" });
  assert.equal(response.status, 404);
  assert.equal(response.body.code, "MATTER_TASK_NOT_FOUND");
});

test("課題紐付け: 追加はUPSERTで返り、案件編集権限を要する", async () => {
  const { app, issues } = appFor({ enabled: true });
  const res = await request(app).post("/api/v2/matters/5/issues")
    .send({ backlogIssueKey: "LB-9", relation: "duplicate", note: "重複" });
  assert.equal(res.status, 201);
  assert.equal(res.body.issue.backlogIssueKey, "LB-9");
  assert.equal(res.body.issue.relation, "duplicate");
  // 再追加は UPSERT（relation 更新）。
  const again = await request(app).post("/api/v2/matters/5/issues")
    .send({ backlogIssueKey: "LB-9", relation: "related" });
  assert.equal(again.body.issue.relation, "related");
  assert.equal((await issues.detach(5, "LB-9")), true);
});

test("課題紐付け: 解除は removed を返す", async () => {
  const { app } = appFor({ enabled: true });
  await request(app).post("/api/v2/matters/5/issues").send({ backlogIssueKey: "LB-9" });
  const res = await request(app).delete("/api/v2/matters/5/issues/LB-9");
  assert.equal(res.status, 200);
  assert.equal(res.body.removed, true);
  const miss = await request(app).delete("/api/v2/matters/5/issues/LB-404");
  assert.equal(miss.body.removed, false);
});

test("課題紐付け: 書込無効時は503、依頼者は403", async () => {
  const off = await request(appFor({ enabled: false }).app).post("/api/v2/matters/5/issues").send({ backlogIssueKey: "LB-9" });
  assert.equal(off.status, 503);
  const req = await request(appFor({ enabled: true, role: "requester" }).app).post("/api/v2/matters/5/issues").send({ backlogIssueKey: "LB-9" });
  assert.equal(req.status, 403);
});

test("課題紐付け: キー無しは400", async () => {
  const { app } = appFor({ enabled: true });
  const res = await request(app).post("/api/v2/matters/5/issues").send({ relation: "related" });
  assert.equal(res.status, 400);
});
