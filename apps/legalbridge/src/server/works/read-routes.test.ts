import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createWorkReadRouter } from "./read-routes.js";
import {
  MemoryWorkReadRepository, type WorkCore, type WorkDetail
} from "./read-repository.js";

const work = (over: Partial<WorkCore> & { id: number }): WorkCore => ({
  workCode: `W-${over.id}`, title: `作品${over.id}`, titleKana: null, kind: null,
  isOriginal: null, workType: null, status: null, parentWorkId: null, isActive: true,
  businessLine: null, derivationType: null, rightsHolderVendorId: null, rightsHolderName: null,
  creatorName: null, publisherName: null, ledgerCode: null, remarks: null, ...over
});

function app(opts: {
  role?: string;
  works?: WorkCore[];
  details?: Map<number, Omit<WorkDetail, "work">>;
} = {}) {
  const a = express();
  a.use((_req, res, next) => {
    res.locals.currentUser = opts.role
      ? ({ email: "u@example.com", role: opts.role, subject: "u", source: "test" } as never)
      : undefined;
    next();
  });
  a.use("/api/v2", createWorkReadRouter(
    new MemoryWorkReadRepository(opts.works ?? [], opts.details ?? new Map())
  ));
  return a;
}

test("一覧: admin/legal以外は403", async () => {
  const res = await request(app({ role: "requester" })).get("/api/v2/works");
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "WORK_READ_ROLE_REQUIRED");
});

test("一覧: legalはキーワード検索できる", async () => {
  const works = [work({ id: 1, title: "ドラゴン" }), work({ id: 2, title: "スライム" })];
  const res = await request(app({ role: "legal", works })).get("/api/v2/works?keyword=ドラゴン");
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 1);
  assert.equal(res.body.works[0].id, 1);
});

test("一覧: 非アクティブは除外", async () => {
  const works = [work({ id: 1 }), work({ id: 2, isActive: false })];
  const res = await request(app({ role: "admin", works })).get("/api/v2/works");
  assert.equal(res.body.total, 1);
  assert.equal(res.body.works[0].id, 1);
});

test("一覧: limitは1..200に丸める（0は400）", async () => {
  const res = await request(app({ role: "legal" })).get("/api/v2/works?limit=0");
  assert.equal(res.status, 400);
});

test("詳細: 存在しない作品は404", async () => {
  const res = await request(app({ role: "legal", works: [work({ id: 1 })] }))
    .get("/api/v2/works/99/detail");
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "WORK_NOT_FOUND");
});

test("詳細: legalは作品概要と集約セクションを取得できる", async () => {
  const works = [work({ id: 1, title: "原作X", isOriginal: true })];
  const details = new Map<number, Omit<WorkDetail, "work">>([[1, {
    lineage: { chain: [{ workId: 1, title: "原作X", workCode: "W-1", label: "原作", isSelected: true }],
      children: [], unlinkedRelationParents: [], depth: 0, isDerivative: false },
    materials: [],
    rightsSources: null, // grant 007 未適用の縮退を模擬
    conditions: { receivable: [], payable: [], sublicense: [], workLevel: [], materialLinked: [],
      totals: { count: 0, receivableCount: 0, payableCount: 0, sublicenseCount: 0, workLevelCount: 0 } }
  }]]);
  const res = await request(app({ role: "admin", works, details })).get("/api/v2/works/1/detail");
  assert.equal(res.status, 200);
  assert.equal(res.body.work.title, "原作X");
  assert.equal(res.body.work.isOriginal, true);
  assert.equal(res.body.lineage.isDerivative, false);
  assert.deepEqual(res.body.materials, []);
  assert.equal(res.body.rightsSources, null);
  assert.equal(res.body.conditions.totals.count, 0);
});

test("詳細: 不正なIDは400", async () => {
  const res = await request(app({ role: "legal" })).get("/api/v2/works/abc/detail");
  assert.equal(res.status, 400);
});
