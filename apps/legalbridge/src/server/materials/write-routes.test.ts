import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createMaterialWriteRouter } from "./write-routes.js";
import { MemoryMaterialWriteRepository } from "./write-repository.js";

function appFor(options: { enabled: boolean; role?: "admin" | "legal" | "requester" }) {
  const repository = new MemoryMaterialWriteRepository();
  const app = express();
  app.use(express.json());
  app.use((_request, response, next) => {
    response.locals.currentUser = { email: "editor@arclight.co.jp", subject: "t", role: options.role ?? "admin", source: "disabled" };
    next();
  });
  app.use("/api/v2", createMaterialWriteRouter(repository, options.enabled));
  return { app, repository };
}

const base = { workId: 1, materialName: "第1原稿", materialType: "manuscript", materialRole: "core_logic", acquisitionType: "license" };

test("素材検証は素材名・区分・役割・取得区分を課す", async () => {
  const { app } = appFor({ enabled: true });
  const response = await request(app).post("/api/v2/materials/validate").send({ workId: 1, materialName: "" });
  assert.equal(response.status, 400);
  assert.ok(response.body.errors.some((e: { field: string }) => e.field === "materialName"));
});

test("書込み無効時は素材作成を拒否する", async () => {
  const { app } = appFor({ enabled: false });
  const response = await request(app).post("/api/v2/materials").send(base);
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "MATERIAL_WRITE_UNAVAILABLE");
});

test("依頼者ロールは素材を編集できない", async () => {
  const { app } = appFor({ enabled: true, role: "requester" });
  const response = await request(app).post("/api/v2/materials").send(base);
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "MATERIAL_EDIT_FORBIDDEN");
});

test("素材を作成し作品コード基準の素材コードを返す", async () => {
  const { app } = appFor({ enabled: true });
  const response = await request(app).post("/api/v2/materials").send(base);
  assert.equal(response.status, 201);
  assert.equal(typeof response.body.id, "number");
  assert.equal(response.body.workId, 1);
  assert.match(response.body.materialCode, /^WRK-00001-\d{3}$/);
});

test("存在しない作品への素材作成は422を返す", async () => {
  const { app } = appFor({ enabled: true });
  const response = await request(app).post("/api/v2/materials").send({ ...base, workId: 999 });
  assert.equal(response.status, 422);
  assert.equal(response.body.code, "MATERIAL_WORK_NOT_FOUND");
});

test("存在しない素材の更新は404を返す", async () => {
  const { app } = appFor({ enabled: true });
  const response = await request(app).patch("/api/v2/materials/999").send({ materialName: "改題" });
  assert.equal(response.status, 404);
  assert.equal(response.body.code, "MATERIAL_NOT_FOUND");
});

test("素材を部分更新できる", async () => {
  const { app } = appFor({ enabled: true });
  const created = await request(app).post("/api/v2/materials").send(base);
  const response = await request(app).patch(`/api/v2/materials/${created.body.id}`).send({ materialName: "第2原稿", remarks: "更新" });
  assert.equal(response.status, 200);
  assert.equal(response.body.id, created.body.id);
});

test("編集用に素材の生値を返す", async () => {
  const { app } = appFor({ enabled: true });
  const created = await request(app).post("/api/v2/materials").send({ ...base, territory: "日本" });
  const response = await request(app).get(`/api/v2/materials/${created.body.id}`);
  assert.equal(response.status, 200);
  assert.equal(response.body.material.materialName, "第1原稿");
  assert.equal(response.body.material.territory, "日本");
});

test("作品ピッカーは作品候補を返す", async () => {
  const { app } = appFor({ enabled: true });
  const response = await request(app).get("/api/v2/materials/works").query({ q: "テスト" });
  assert.equal(response.status, 200);
  assert.equal(response.body.works[0].id, 1);
});

test("依頼者ロールは素材の生値を取得できない", async () => {
  const { app } = appFor({ enabled: true, role: "requester" });
  const response = await request(app).get("/api/v2/materials/1");
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "MATERIAL_EDIT_FORBIDDEN");
});
