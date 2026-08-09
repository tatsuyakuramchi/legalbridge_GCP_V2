import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createMatterMergeRouter } from "./matter-merge-routes.js";
import { MemoryMatterMergeRepository, type MatterRef } from "./matter-merge-repository.js";

function appFor(opts: { enabled?: boolean; role?: string } = {}) {
  const matters = new Map<number, MatterRef>([
    [1, { id: 1, matterCode: "M-1", title: "統合先", status: "active", driveFolderId: null }],
    [2, { id: 2, matterCode: "M-2", title: "重複案件", status: "active", driveFolderId: "folder-src" }]
  ]);
  const counts = new Map<number, Partial<Record<string, number>>>([
    [2, { issues: 2, tasks: 1, documents: 3, sends: 1 }]
  ]);
  const repository = new MemoryMatterMergeRepository(matters, counts);
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.currentUser = { email: "u@arclight.co.jp", subject: "t", role: opts.role ?? "admin", source: "test" } as never;
    next();
  });
  app.use("/api/v2", createMatterMergeRouter(repository, opts.enabled ?? false));
  return { app, repository };
}

test("プレビュー: admin/legal以外は403", async () => {
  const { app } = appFor({ role: "requester" });
  const res = await request(app).get("/api/v2/matter-merge/preview?targetId=1&sourceId=2");
  assert.equal(res.status, 403);
});

test("プレビュー: 移送件数を集計する（読取・書込無効でも可）", async () => {
  const { app } = appFor({ enabled: false });
  const res = await request(app).get("/api/v2/matter-merge/preview?targetId=1&sourceId=2");
  assert.equal(res.status, 200);
  assert.equal(res.body.preview.totalMovable, 7);
  assert.equal(res.body.preview.target.id, 1);
  assert.equal(res.body.preview.source.id, 2);
  assert.equal(res.body.writeEnabled, false);
});

test("プレビュー: 同一案件は400", async () => {
  const { app } = appFor({ enabled: true });
  const res = await request(app).get("/api/v2/matter-merge/preview?targetId=1&sourceId=1");
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "MATTER_MERGE_SAME");
});

test("プレビュー: 存在しない統合元は404", async () => {
  const { app } = appFor({ enabled: true });
  const res = await request(app).get("/api/v2/matter-merge/preview?targetId=1&sourceId=99");
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "MATTER_MERGE_SOURCE_NOT_FOUND");
});

test("実行: 書込み無効時は503", async () => {
  const { app } = appFor({ enabled: false });
  const res = await request(app).post("/api/v2/matter-merge").send({ targetId: 1, sourceId: 2, confirmation: "COMMIT_MATTER_MERGE" });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "MATTER_MERGE_WRITE_UNAVAILABLE");
});

test("実行: 確認トークン不正は400", async () => {
  const { app } = appFor({ enabled: true });
  const res = await request(app).post("/api/v2/matter-merge").send({ targetId: 1, sourceId: 2, confirmation: "WRONG" });
  assert.equal(res.status, 400);
});

test("実行: 名寄せで紐付きを移送し統合元をアーカイブ・Driveを引継ぐ", async () => {
  const { app, repository } = appFor({ enabled: true });
  const res = await request(app).post("/api/v2/matter-merge").send({ targetId: 1, sourceId: 2, confirmation: "COMMIT_MATTER_MERGE" });
  assert.equal(res.status, 200);
  assert.equal(res.body.totalMoved, 7);
  assert.equal(res.body.folderAction, "adopted");
  assert.equal(res.body.sourceArchived, true);
  assert.equal(repository.matters.get(2)?.status, "archived");
  assert.equal(repository.matters.get(1)?.driveFolderId, "folder-src");
});

test("実行: 自己マージは400", async () => {
  const { app } = appFor({ enabled: true });
  const res = await request(app).post("/api/v2/matter-merge").send({ targetId: 1, sourceId: 1, confirmation: "COMMIT_MATTER_MERGE" });
  assert.equal(res.status, 400);
});
