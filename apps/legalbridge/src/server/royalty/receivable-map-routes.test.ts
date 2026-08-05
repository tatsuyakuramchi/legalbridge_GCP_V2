import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createReceivableMapRouter } from "./receivable-map-routes.js";
import { MemoryReceivableMapRepository } from "./receivable-map-repository.js";
import type { LineageTierInput } from "./receivable-map.js";

function app(opts: { role?: string; data?: Map<number, LineageTierInput[]> } = {}) {
  const a = express();
  a.use((_req, res, next) => {
    res.locals.currentUser = opts.role
      ? ({ email: "u@example.com", role: opts.role, subject: "u", source: "test" } as never)
      : undefined;
    next();
  });
  a.use("/api/v2", createReceivableMapRouter(new MemoryReceivableMapRepository(opts.data ?? new Map())));
  return a;
}

test("admin/legal 以外は403", async () => {
  const res = await request(app({ role: "requester" })).get("/api/v2/receivable-map?workId=1");
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "RECEIVABLE_MAP_ROLE_REQUIRED");
});

test("データが無い作品は404", async () => {
  const res = await request(app({ role: "legal" })).get("/api/v2/receivable-map?workId=99");
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "RECEIVABLE_MAP_NOT_FOUND");
});

test("legalは作品の分配カスケードを取得できる", async () => {
  const data = new Map<number, LineageTierInput[]>([[1, [
    { workId: 1, workTitle: "作品A", received: 5000, upstream: [{ capabilityId: 1, ratePct: 10 }] },
    { workId: 2, workTitle: "派生B", received: 3000, upstream: [{ capabilityId: 2, ratePct: 20 }] }
  ]]]);
  const res = await request(app({ role: "admin", data })).get("/api/v2/receivable-map?workId=1");
  assert.equal(res.status, 200);
  assert.equal(res.body.map.chain.length, 2);
  assert.equal(res.body.map.totals.received, 8000);
  assert.equal(res.body.map.totals.distributed, 1400); // round(8000×10%)+round(3000×20%)
});

test("workId未指定は400", async () => {
  const res = await request(app({ role: "legal" })).get("/api/v2/receivable-map");
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "invalid request");
});
