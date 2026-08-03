import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createStaffRouter } from "./routes.js";
import { MemoryStaffRepository } from "./repository.js";

function appFor(options: { enabled: boolean; role?: "admin" | "legal" | "requester" }) {
  const repository = new MemoryStaffRepository();
  const app = express();
  app.use(express.json());
  app.use((_request, response, next) => {
    response.locals.currentUser = { email: "admin@arclight.co.jp", subject: "t", role: options.role ?? "admin", source: "disabled" };
    next();
  });
  app.use("/api/v2", createStaffRouter(repository, options.enabled));
  return { app, repository };
}

test("担当者検証はSlackID・氏名の必須を課す", async () => {
  const { app } = appFor({ enabled: true });
  const response = await request(app).post("/api/v2/staff/validate").send({ staffName: "" });
  assert.equal(response.status, 400);
});

test("書込み無効時は担当者作成を拒否する", async () => {
  const { app } = appFor({ enabled: false });
  const response = await request(app).post("/api/v2/staff").send({ slackUserId: "U1", staffName: "田中" });
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "STAFF_WRITE_UNAVAILABLE");
});

test("依頼者ロールは担当者一覧を取得できない", async () => {
  const { app } = appFor({ enabled: true, role: "requester" });
  const response = await request(app).get("/api/v2/staff");
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "STAFF_EDIT_FORBIDDEN");
});

test("担当者を作成・一覧・取得できる", async () => {
  const { app } = appFor({ enabled: true });
  const created = await request(app).post("/api/v2/staff").send({ slackUserId: "U01", staffName: "田中太郎", department: "法務部" });
  assert.equal(created.status, 201);
  const list = await request(app).get("/api/v2/staff");
  assert.equal(list.body.items.length, 1);
  const detail = await request(app).get(`/api/v2/staff/${created.body.id}`);
  assert.equal(detail.body.staff.staffName, "田中太郎");
});

test("重複するSlackIDは409を返す", async () => {
  const { app } = appFor({ enabled: true });
  await request(app).post("/api/v2/staff").send({ slackUserId: "U09", staffName: "A" });
  const dup = await request(app).post("/api/v2/staff").send({ slackUserId: "U09", staffName: "B" });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, "STAFF_CONFLICT");
});

test("存在しない担当者の更新は404を返す", async () => {
  const { app } = appFor({ enabled: true });
  const response = await request(app).patch("/api/v2/staff/999").send({ staffName: "改名" });
  assert.equal(response.status, 404);
});
