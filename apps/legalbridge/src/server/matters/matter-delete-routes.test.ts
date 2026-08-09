import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createMatterDeleteRouter } from "./matter-delete-routes.js";
import {
  MemoryMatterDeleteRepository, type MatterRef, type MemoryTask
} from "./matter-delete-repository.js";

function appFor(opts: { enabled?: boolean; role?: string } = {}) {
  const matters = new Map<number, MatterRef>([
    [1, { id: 1, matterCode: "M-1", title: "削除対象", status: "active" }]
  ]);
  const tasks = new Map<number, MemoryTask>([
    [10, { id: 10, matterId: 1, isPrimary: true }],
    [11, { id: 11, matterId: 1, isPrimary: false }]
  ]);
  const counts = new Map<number, Partial<Record<string, number>>>([
    [1, { issues: 2, tasks: 2, documents: 3, sends: 1 }]
  ]);
  const repository = new MemoryMatterDeleteRepository(matters, tasks, counts);
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.currentUser = { email: "u@arclight.co.jp", subject: "t", role: opts.role ?? "admin", source: "test" } as never;
    next();
  });
  app.use("/api/v2", createMatterDeleteRouter(repository, opts.enabled ?? false));
  return { app, repository };
}

test("プレビュー: admin/legal以外は403", async () => {
  const { app } = appFor({ role: "requester" });
  const res = await request(app).get("/api/v2/matters/1/delete-preview");
  assert.equal(res.status, 403);
});

test("プレビュー: 連鎖・解除の件数を返す（書込無効でも可）", async () => {
  const { app } = appFor({ enabled: false });
  const res = await request(app).get("/api/v2/matters/1/delete-preview");
  assert.equal(res.status, 200);
  assert.equal(res.body.writeEnabled, false);
  const issues = res.body.preview.impacts.find((i: { key: string }) => i.key === "issues");
  const documents = res.body.preview.impacts.find((i: { key: string }) => i.key === "documents");
  assert.equal(issues.count, 2);
  assert.equal(issues.effect, "cascade");
  assert.equal(documents.effect, "unlink");
});

test("プレビュー: 存在しない案件は404", async () => {
  const { app } = appFor({ enabled: true });
  const res = await request(app).get("/api/v2/matters/99/delete-preview");
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "MATTER_DELETE_NOT_FOUND");
});

test("案件削除: 書込み無効時は503", async () => {
  const { app } = appFor({ enabled: false });
  const res = await request(app).delete("/api/v2/matters/1").send({ confirmation: "COMMIT_MATTER_DELETE" });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "MATTER_DELETE_WRITE_UNAVAILABLE");
});

test("案件削除: 確認トークン不正は400", async () => {
  const { app } = appFor({ enabled: true });
  const res = await request(app).delete("/api/v2/matters/1").send({ confirmation: "WRONG" });
  assert.equal(res.status, 400);
});

test("案件削除: 連鎖・解除件数を返し案件を削除する", async () => {
  const { app, repository } = appFor({ enabled: true });
  const res = await request(app).delete("/api/v2/matters/1").send({ confirmation: "COMMIT_MATTER_DELETE" });
  assert.equal(res.status, 200);
  assert.equal(res.body.deletedId, 1);
  assert.equal(res.body.cascaded.issues, 2);
  assert.equal(res.body.unlinked.documents, 3);
  assert.equal(repository.matters.has(1), false);
});

test("タスク削除: 代表タスクは409", async () => {
  const { app } = appFor({ enabled: true });
  const res = await request(app).delete("/api/v2/matters/1/tasks/10");
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "MATTER_TASK_PRIMARY");
});

test("タスク削除: 非代表タスクを削除する", async () => {
  const { app, repository } = appFor({ enabled: true });
  const res = await request(app).delete("/api/v2/matters/1/tasks/11");
  assert.equal(res.status, 200);
  assert.equal(res.body.deletedId, 11);
  assert.equal(repository.tasks.has(11), false);
});

test("タスク削除: 存在しないタスクは404", async () => {
  const { app } = appFor({ enabled: true });
  const res = await request(app).delete("/api/v2/matters/1/tasks/999");
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "MATTER_TASK_NOT_FOUND");
});
