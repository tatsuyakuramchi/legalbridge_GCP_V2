import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createRightsSourceWriteRouter } from "./rights-source-write-routes.js";
import { MemoryRightsSourceWriteRepository } from "./rights-source-write-repository.js";

function appFor(options: { enabled: boolean; role?: "admin" | "legal" | "requester" }) {
  const repository = new MemoryRightsSourceWriteRepository();
  const app = express();
  app.use(express.json());
  app.use((_request, response, next) => {
    response.locals.currentUser = { email: "editor@arclight.co.jp", subject: "t", role: options.role ?? "admin", source: "disabled" };
    next();
  });
  app.use("/api/v2", createRightsSourceWriteRouter(repository, options.enabled));
  return { app, repository };
}

test("検証は素材IDとソース種別を必須にする", async () => {
  const { app } = appFor({ enabled: true });
  const res = await request(app).post("/api/v2/rights-sources/validate").send({ sourceType: "" });
  assert.equal(res.status, 400);
  const fields = res.body.errors.map((e: { field: string }) => e.field);
  assert.ok(fields.includes("materialId"));
  assert.ok(fields.includes("sourceType"));
});

test("書込み無効時は作成を拒否する", async () => {
  const { app } = appFor({ enabled: false });
  const res = await request(app).post("/api/v2/rights-sources").send({ materialId: 1, sourceType: "direct_contract" });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "RIGHTS_SOURCE_WRITE_UNAVAILABLE");
});

test("依頼者ロールは権利ソースを編集できない", async () => {
  const { app } = appFor({ enabled: true, role: "requester" });
  const res = await request(app).post("/api/v2/rights-sources").send({ materialId: 1, sourceType: "direct_contract" });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "RIGHTS_SOURCE_EDIT_FORBIDDEN");
});

test("権利ソースを作成できる", async () => {
  const { app } = appFor({ enabled: true });
  const res = await request(app).post("/api/v2/rights-sources").send({
    materialId: 5, sourceType: "direct_contract", isPrimary: true, validFrom: "2026-01-01"
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.materialId, 5);
  assert.equal(typeof res.body.id, "number");
});

test("不正な日付形式は400", async () => {
  const { app } = appFor({ enabled: true });
  const res = await request(app).post("/api/v2/rights-sources").send({
    materialId: 5, sourceType: "direct_contract", validFrom: "2026/01/01"
  });
  assert.equal(res.status, 400);
});

test("存在しない権利ソースの更新は404", async () => {
  const { app } = appFor({ enabled: true });
  const res = await request(app).patch("/api/v2/rights-sources/999").send({ isPrimary: false });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "RIGHTS_SOURCE_NOT_FOUND");
});

test("権利ソースを部分更新できる", async () => {
  const { app } = appFor({ enabled: true });
  const created = await request(app).post("/api/v2/rights-sources").send({ materialId: 5, sourceType: "direct_contract" });
  const res = await request(app).patch(`/api/v2/rights-sources/${created.body.id}`).send({ sourceRole: "原作者", isPrimary: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.id, created.body.id);
});

test("空の更新は400", async () => {
  const { app } = appFor({ enabled: true });
  const created = await request(app).post("/api/v2/rights-sources").send({ materialId: 5, sourceType: "direct_contract" });
  const res = await request(app).patch(`/api/v2/rights-sources/${created.body.id}`).send({});
  assert.equal(res.status, 400);
});

test("権利ソースCSV一括取込は有効行を登録し無効行を報告する", async () => {
  const { app } = appFor({ enabled: true });
  const res = await request(app).post("/api/v2/rights-sources/import").send({
    rows: [
      { materialId: "10", sourceType: "direct_contract", isPrimary: "○", validFrom: "2026-01-01" },
      { materialId: "", sourceType: "direct_contract" },
      { materialId: "11", sourceType: "" }
    ]
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.insertedCount, 1);
  assert.equal(res.body.failedCount, 2);
});

test("権利ソースCSV取込は書込み無効時に拒否する", async () => {
  const { app } = appFor({ enabled: false });
  const res = await request(app).post("/api/v2/rights-sources/import").send({ rows: [{ materialId: "10", sourceType: "direct_contract" }] });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "RIGHTS_SOURCE_WRITE_UNAVAILABLE");
});
