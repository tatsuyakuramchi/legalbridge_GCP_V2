import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createDocumentImportRouter } from "./import-routes.js";
import { MemoryDocumentImportRepository } from "./import-repository.js";

function appFor(options: { enabled: boolean; role?: "admin" | "legal" | "requester" }) {
  const app = express();
  app.use(express.json());
  app.use((_request, response, next) => {
    response.locals.currentUser = { email: "admin@arclight.co.jp", subject: "t", role: options.role ?? "admin", source: "disabled" };
    next();
  });
  app.use("/api/v2", createDocumentImportRouter(new MemoryDocumentImportRepository(), options.enabled));
  return app;
}

test("取込無効時は過去文書取込を拒否する", async () => {
  const response = await request(appFor({ enabled: false }))
    .post("/api/v2/documents/import").send({ rows: [{ documentNumber: "PO-1", templateType: "purchase_order" }] });
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "DOCUMENT_IMPORT_UNAVAILABLE");
});

test("依頼者ロールは過去文書取込できない", async () => {
  const response = await request(appFor({ enabled: true, role: "requester" }))
    .post("/api/v2/documents/import").send({ rows: [{ documentNumber: "PO-1", templateType: "purchase_order" }] });
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "DOCUMENT_IMPORT_FORBIDDEN");
});

test("有効行を取込み無効行・重複を報告する", async () => {
  const response = await request(appFor({ enabled: true })).post("/api/v2/documents/import").send({
    rows: [
      { documentNumber: "PO-1", templateType: "purchase_order", issueKey: "LEGAL-1" },
      { documentNumber: "", templateType: "purchase_order" },
      { documentNumber: "PO-1", templateType: "purchase_order" }
    ]
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.insertedCount, 1);
  assert.equal(response.body.failedCount, 2);
});

test("validate は不正行を報告する", async () => {
  const response = await request(appFor({ enabled: true })).post("/api/v2/documents/import/validate").send({
    rows: [{ documentNumber: "PO-1", templateType: "purchase_order" }, { documentNumber: "" }]
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.errors[0].index, 1);
});
