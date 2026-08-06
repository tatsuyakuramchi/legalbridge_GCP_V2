import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createDataQualityRouter } from "./routes.js";
import { MemoryDataQualityRepository } from "./repository.js";
import type { QualityCategory } from "./scan.js";

function app(opts: { role?: string; categories?: QualityCategory[] } = {}) {
  const a = express();
  a.use((_req, res, next) => {
    res.locals.currentUser = opts.role
      ? ({ email: "u@example.com", role: opts.role, subject: "u", source: "test" } as never)
      : undefined;
    next();
  });
  a.use("/api/v2", createDataQualityRouter(new MemoryDataQualityRepository(opts.categories ?? [])));
  return a;
}

test("admin/legal以外は403", async () => {
  const res = await request(app({ role: "requester" })).get("/api/v2/data-quality");
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "DATA_QUALITY_ROLE_REQUIRED");
});

test("legalは品質レポートを取得できる", async () => {
  const categories: QualityCategory[] = [
    { key: "unlinked-conditions", label: "未リンク条件明細", description: "", severity: "high", available: true, count: 4, samples: [{ id: 1, label: "条件A", detail: "未設定: 作品" }] },
    { key: "dup", label: "重複", description: "", severity: "medium", available: false, count: 0, samples: [] }
  ];
  const res = await request(app({ role: "legal", categories })).get("/api/v2/data-quality");
  assert.equal(res.status, 200);
  assert.equal(res.body.summary.totalIssues, 4);
  assert.equal(res.body.summary.unavailableCategories, 1);
  // high が先頭。
  assert.equal(res.body.categories[0].key, "unlinked-conditions");
  assert.equal(res.body.categories[0].samples[0].label, "条件A");
});
