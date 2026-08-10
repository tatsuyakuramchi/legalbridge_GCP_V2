import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createVendorWriteRouter } from "./write-routes.js";
import { MemoryVendorWriteRepository } from "./write-repository.js";

function appFor(options: { enabled: boolean; role?: "admin" | "legal" | "requester" }) {
  const repository = new MemoryVendorWriteRepository();
  const app = express();
  app.use(express.json());
  app.use((_request, response, next) => {
    response.locals.currentUser = { email: "editor@arclight.co.jp", subject: "t", role: options.role ?? "admin", source: "disabled" };
    next();
  });
  app.use("/api/v2", createVendorWriteRouter(repository, options.enabled));
  return { app, repository };
}

test("取引先検証は名称必須を課す", async () => {
  const { app } = appFor({ enabled: true });
  const response = await request(app).post("/api/v2/vendors/validate").send({ vendorName: "" });
  assert.equal(response.status, 400);
  assert.ok(response.body.errors.some((e: { field: string }) => e.field === "vendorName"));
});

test("書込み無効時は取引先作成を拒否する", async () => {
  const { app } = appFor({ enabled: false });
  const response = await request(app).post("/api/v2/vendors").send({ vendorName: "新会社" });
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "VENDOR_WRITE_UNAVAILABLE");
});

test("依頼者ロールは取引先を編集できない", async () => {
  const { app } = appFor({ enabled: true, role: "requester" });
  const response = await request(app).post("/api/v2/vendors").send({ vendorName: "新会社" });
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "VENDOR_EDIT_FORBIDDEN");
});

test("取引先を作成し自動採番コードを返す", async () => {
  const { app } = appFor({ enabled: true });
  const response = await request(app).post("/api/v2/vendors").send({ vendorName: "アークライト", entityType: "法人" });
  assert.equal(response.status, 201);
  assert.equal(typeof response.body.id, "number");
  assert.match(response.body.vendorCode, /^VEN-\d{5}$/);
});

test("存在しない取引先の更新は404を返す", async () => {
  const { app } = appFor({ enabled: true });
  const response = await request(app).patch("/api/v2/vendors/999").send({ vendorName: "改名" });
  assert.equal(response.status, 404);
  assert.equal(response.body.code, "VENDOR_NOT_FOUND");
});

test("取引先を部分更新できる", async () => {
  const { app } = appFor({ enabled: true });
  const created = await request(app).post("/api/v2/vendors").send({ vendorName: "旧名" });
  const response = await request(app).patch(`/api/v2/vendors/${created.body.id}`).send({ vendorName: "新名", email: "a@example.com" });
  assert.equal(response.status, 200);
  assert.equal(response.body.id, created.body.id);
});

test("取引先を無効化（is_active=false）して再取得で反映される（11-3）", async () => {
  const { app } = appFor({ enabled: true });
  const created = await request(app).post("/api/v2/vendors").send({ vendorName: "無効化対象" });
  // 既定は有効
  const before = await request(app).get(`/api/v2/vendors/${created.body.id}`);
  assert.equal(before.body.vendor.isActive, true);
  // 無効化
  await request(app).patch(`/api/v2/vendors/${created.body.id}`).send({ isActive: false }).expect(200);
  const after = await request(app).get(`/api/v2/vendors/${created.body.id}`);
  assert.equal(after.body.vendor.isActive, false);
});

test("CSV一括取込は有効行を登録し無効行を報告する", async () => {
  const { app } = appFor({ enabled: true });
  const response = await request(app).post("/api/v2/vendors/import").send({
    rows: [
      { vendorName: "会社A", entityType: "法人" },
      { vendorName: "", email: "x@example.com" },
      { vendorName: "会社B" }
    ]
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.insertedCount, 2);
  assert.equal(response.body.failedCount, 1);
  assert.equal(response.body.failed[0].index, 1);
});

test("一括取込は書込み無効時に拒否する", async () => {
  const { app } = appFor({ enabled: false });
  const response = await request(app).post("/api/v2/vendors/import").send({ rows: [{ vendorName: "A" }] });
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "VENDOR_WRITE_UNAVAILABLE");
});

test("編集用に取引先の生値を返す", async () => {
  const { app } = appFor({ enabled: true });
  const created = await request(app).post("/api/v2/vendors").send({ vendorName: "生値社", email: "raw@example.com" });
  const response = await request(app).get(`/api/v2/vendors/${created.body.id}`);
  assert.equal(response.status, 200);
  assert.equal(response.body.vendor.vendorName, "生値社");
  assert.equal(response.body.vendor.email, "raw@example.com");
});

test("依頼者ロールは取引先の生値を取得できない", async () => {
  const { app } = appFor({ enabled: true, role: "requester" });
  const response = await request(app).get("/api/v2/vendors/1");
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "VENDOR_EDIT_FORBIDDEN");
});
