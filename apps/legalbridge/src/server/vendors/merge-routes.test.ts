import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createVendorMergeRouter } from "./merge-routes.js";
import { MemoryVendorMergeRepository, type VendorRef } from "./merge-repository.js";

function appFor(opts: { enabled?: boolean; role?: string } = {}) {
  const vendors = new Map<number, VendorRef>([
    [1, { id: 1, vendorName: "株式会社アークライト", vendorCode: "V-1", isActive: true }],
    [2, { id: 2, vendorName: "株式会社アークライト", vendorCode: "V-2", isActive: true }]
  ]);
  const repository = new MemoryVendorMergeRepository(vendors, new Map([[2, 7]]));
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.currentUser = { email: "u@arclight.co.jp", subject: "t", role: opts.role ?? "admin", source: "test" } as never;
    next();
  });
  app.use("/api/v2", createVendorMergeRouter(repository, opts.enabled ?? false));
  return { app, repository };
}

test("プレビュー: admin/legal以外は403", async () => {
  const { app } = appFor({ role: "requester" });
  const res = await request(app).get("/api/v2/vendor-merge/preview?targetId=1&sourceId=2");
  assert.equal(res.status, 403);
});

test("プレビュー: 参照件数を集計する（読取・書込無効でも可）", async () => {
  const { app } = appFor({ enabled: false });
  const res = await request(app).get("/api/v2/vendor-merge/preview?targetId=1&sourceId=2");
  assert.equal(res.status, 200);
  assert.equal(res.body.preview.totalReferences, 7);
  assert.equal(res.body.preview.target.id, 1);
  assert.equal(res.body.preview.source.id, 2);
  assert.equal(res.body.writeEnabled, false);
});

test("プレビュー: 同一取引先は400", async () => {
  const { app } = appFor({ enabled: true });
  const res = await request(app).get("/api/v2/vendor-merge/preview?targetId=1&sourceId=1");
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "VENDOR_MERGE_SAME");
});

test("プレビュー: 存在しない統合元は404", async () => {
  const { app } = appFor({ enabled: true });
  const res = await request(app).get("/api/v2/vendor-merge/preview?targetId=1&sourceId=99");
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "VENDOR_MERGE_SOURCE_NOT_FOUND");
});

test("実行: 書込み無効時は503", async () => {
  const { app } = appFor({ enabled: false });
  const res = await request(app).post("/api/v2/vendor-merge").send({ targetId: 1, sourceId: 2, confirmation: "COMMIT_VENDOR_MERGE" });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "VENDOR_MERGE_WRITE_UNAVAILABLE");
});

test("実行: 確認トークン不正は400", async () => {
  const { app } = appFor({ enabled: true });
  const res = await request(app).post("/api/v2/vendor-merge").send({ targetId: 1, sourceId: 2, confirmation: "WRONG" });
  assert.equal(res.status, 400);
});

test("実行: 名寄せで参照を再指定し統合元を無効化する", async () => {
  const { app, repository } = appFor({ enabled: true });
  const res = await request(app).post("/api/v2/vendor-merge").send({ targetId: 1, sourceId: 2, confirmation: "COMMIT_VENDOR_MERGE" });
  assert.equal(res.status, 200);
  assert.equal(res.body.totalRepointed, 7);
  assert.equal(res.body.sourceDeactivated, true);
  assert.equal(repository.vendors.get(2)?.isActive, false);
});

test("実行: 自己マージは400", async () => {
  const { app } = appFor({ enabled: true });
  const res = await request(app).post("/api/v2/vendor-merge").send({ targetId: 1, sourceId: 1, confirmation: "COMMIT_VENDOR_MERGE" });
  assert.equal(res.status, 400);
});
