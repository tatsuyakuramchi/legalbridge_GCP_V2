import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createDocumentVoidRouter } from "./document-void-routes.js";
import {
  MemoryDocumentVoidRepository, type MemoryVoidDoc, type MemoryVoidEvent
} from "./document-void-repository.js";

function appFor(opts: { enabled?: boolean; role?: string; forbidden?: boolean; notify?: (k: string, t: string) => Promise<void> } = {}) {
  const docs: MemoryVoidDoc[] = [
    { id: 1, documentNumber: "ARC-PO-2026-0001", issueKey: "LB-1", lifecycleStatus: "final" },
    { id: 2, documentNumber: "ARC-PO-2026-0002", issueKey: null, lifecycleStatus: "voided" }
  ];
  const events: MemoryVoidEvent[] = [
    { id: 100, documentId: 1, conditionLineId: 50, voidedAt: null, voidReason: null },
    { id: 101, documentId: 1, conditionLineId: 50, voidedAt: null, voidReason: null },
    { id: 102, documentId: 1, conditionLineId: 51, voidedAt: null, voidReason: null }
  ];
  const repository = new MemoryDocumentVoidRepository(docs, events, opts.forbidden ?? false);
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.currentUser = { email: "u@arclight.co.jp", subject: "t", role: opts.role ?? "admin", source: "test" } as never;
    next();
  });
  app.use("/api/v2", createDocumentVoidRouter(repository, opts.enabled ?? false, opts.notify));
  return { app, repository };
}

test("void: 書込み無効時は503", async () => {
  const { app } = appFor({ enabled: false });
  const res = await request(app).post("/api/v2/documents/1/void").send({ confirmation: "COMMIT_DOCUMENT_VOID" });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "DOCUMENT_VOID_WRITE_UNAVAILABLE");
});

test("void: admin/legal 以外は403", async () => {
  const { app } = appFor({ enabled: true, role: "requester" });
  const res = await request(app).post("/api/v2/documents/1/void").send({ confirmation: "COMMIT_DOCUMENT_VOID" });
  assert.equal(res.status, 403);
});

test("void: 確認トークン不正は400", async () => {
  const { app } = appFor({ enabled: true });
  const res = await request(app).post("/api/v2/documents/1/void").send({ confirmation: "WRONG" });
  assert.equal(res.status, 400);
});

test("void: 文書を無効化し実績を取消して件数を返す", async () => {
  const posted: string[] = [];
  const { app } = appFor({ enabled: true, notify: async (_k, t) => { posted.push(t); } });
  const res = await request(app).post("/api/v2/documents/1/void")
    .send({ confirmation: "COMMIT_DOCUMENT_VOID", reason: "誤発行" });
  assert.equal(res.status, 200);
  assert.equal(res.body.alreadyVoided, false);
  assert.equal(res.body.voidedEvents, 3);
  assert.deepEqual(res.body.affectedLines.sort(), [50, 51]);
  // Backlog 通知はベストエフォート（非同期）だが reason を含む
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(posted.length, 1);
  assert.match(posted[0], /誤発行/);
});

test("void: 存在しない文書は404", async () => {
  const { app } = appFor({ enabled: true });
  const res = await request(app).post("/api/v2/documents/999/void").send({ confirmation: "COMMIT_DOCUMENT_VOID" });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "DOCUMENT_VOID_NOT_FOUND");
});

test("void: 既に void 済みは alreadyVoided=true・副作用なし", async () => {
  const posted: string[] = [];
  const { app } = appFor({ enabled: true, notify: async (_k, t) => { posted.push(t); } });
  const res = await request(app).post("/api/v2/documents/2/void").send({ confirmation: "COMMIT_DOCUMENT_VOID" });
  assert.equal(res.status, 200);
  assert.equal(res.body.alreadyVoided, true);
  assert.equal(res.body.voidedEvents, 0);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(posted.length, 0); // 既 void は通知しない
});

test("void: 権限未整備(FORBIDDEN_DB)は503", async () => {
  const { app } = appFor({ enabled: true, forbidden: true });
  const res = await request(app).post("/api/v2/documents/1/void").send({ confirmation: "COMMIT_DOCUMENT_VOID" });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "DOCUMENT_VOID_FORBIDDEN_DB");
});

test("void-bulk: 混在（voided/already/not_found）を集計する", async () => {
  const { app } = appFor({ enabled: true });
  const res = await request(app).post("/api/v2/documents/void-bulk")
    .send({ ids: [1, 2, 999, 1], confirmation: "COMMIT_DOCUMENT_VOID", reason: "整理" });
  assert.equal(res.status, 200);
  assert.equal(res.body.requested, 3);   // 重複 id=1 は1回
  assert.equal(res.body.voided, 1);      // id=1
  assert.equal(res.body.already, 1);     // id=2（既 void）
  assert.equal(res.body.notFound, 1);    // id=999
});

test("void-bulk: 書込み無効時は503", async () => {
  const { app } = appFor({ enabled: false });
  const res = await request(app).post("/api/v2/documents/void-bulk")
    .send({ ids: [1], confirmation: "COMMIT_DOCUMENT_VOID" });
  assert.equal(res.status, 503);
});

test("void-bulk: 確認トークン不正は400", async () => {
  const { app } = appFor({ enabled: true });
  const res = await request(app).post("/api/v2/documents/void-bulk").send({ ids: [1], confirmation: "WRONG" });
  assert.equal(res.status, 400);
});

test("void-bulk: 権限未整備は503で全体中断", async () => {
  const { app } = appFor({ enabled: true, forbidden: true });
  const res = await request(app).post("/api/v2/documents/void-bulk")
    .send({ ids: [1, 2], confirmation: "COMMIT_DOCUMENT_VOID" });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "DOCUMENT_VOID_FORBIDDEN_DB");
});
