import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createWorkWriteRouter } from "./write-routes.js";
import { MemoryWorkWriteRepository } from "./write-repository.js";

function appFor(options: { enabled: boolean; role?: "admin" | "legal" | "requester" }) {
  const repository = new MemoryWorkWriteRepository();
  const app = express();
  app.use(express.json());
  app.use((_request, response, next) => {
    response.locals.currentUser = { email: "editor@arclight.co.jp", subject: "t", role: options.role ?? "admin", source: "disabled" };
    next();
  });
  app.use("/api/v2", createWorkWriteRouter(repository, options.enabled));
  return { app, repository };
}

test("作品検証は作品名必須を課す", async () => {
  const { app } = appFor({ enabled: true });
  const response = await request(app).post("/api/v2/works/validate").send({ title: "" });
  assert.equal(response.status, 400);
  assert.ok(response.body.errors.some((e: { field: string }) => e.field === "title"));
});

test("書込み無効時は作品作成を拒否する", async () => {
  const { app } = appFor({ enabled: false });
  const response = await request(app).post("/api/v2/works").send({ title: "新作品" });
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "WORK_WRITE_UNAVAILABLE");
});

test("依頼者ロールは作品を編集できない", async () => {
  const { app } = appFor({ enabled: true, role: "requester" });
  const response = await request(app).post("/api/v2/works").send({ title: "新作品" });
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "WORK_EDIT_FORBIDDEN");
});

test("作品を作成し自動採番コードを返す", async () => {
  const { app } = appFor({ enabled: true });
  const response = await request(app).post("/api/v2/works").send({ title: "作品タイトル" });
  assert.equal(response.status, 201);
  assert.equal(typeof response.body.id, "number");
  assert.match(response.body.workCode, /^WRK-\d{5}$/);
});

test("存在しない作品の更新は404を返す", async () => {
  const { app } = appFor({ enabled: true });
  const response = await request(app).patch("/api/v2/works/999").send({ title: "改題" });
  assert.equal(response.status, 404);
  assert.equal(response.body.code, "WORK_NOT_FOUND");
});

test("作品を部分更新できる", async () => {
  const { app } = appFor({ enabled: true });
  const created = await request(app).post("/api/v2/works").send({ title: "旧題" });
  const response = await request(app).patch(`/api/v2/works/${created.body.id}`).send({ title: "新題", remarks: "更新" });
  assert.equal(response.status, 200);
  assert.equal(response.body.id, created.body.id);
});

test("編集用に作品の生値を返す", async () => {
  const { app } = appFor({ enabled: true });
  const created = await request(app).post("/api/v2/works").send({ title: "生値作品", ledgerCode: "LG-1" });
  const response = await request(app).get(`/api/v2/works/${created.body.id}`);
  assert.equal(response.status, 200);
  assert.equal(response.body.work.title, "生値作品");
  assert.equal(response.body.work.ledgerCode, "LG-1");
});

test("依頼者ロールは作品の生値を取得できない", async () => {
  const { app } = appFor({ enabled: true, role: "requester" });
  const response = await request(app).get("/api/v2/works/1");
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "WORK_EDIT_FORBIDDEN");
});
