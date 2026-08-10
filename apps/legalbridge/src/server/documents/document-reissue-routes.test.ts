import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createDocumentReissueRouter } from "./document-reissue-routes.js";
import { nextReissueNumber,
  MemoryDocumentReissueRepository, type MemoryReissueDoc, type MemoryReissueEvent
} from "./document-reissue-repository.js";

test("nextReissueNumber: 系列の最大版+1", () => {
  assert.equal(nextReissueNumber("ARC-PO-2026-0001", ["ARC-PO-2026-0001"]), "ARC-PO-2026-0001-R1");
  assert.equal(nextReissueNumber("ARC-PO-2026-0001", ["ARC-PO-2026-0001", "ARC-PO-2026-0001-R1"]), "ARC-PO-2026-0001-R2");
  assert.equal(nextReissueNumber("ARC-PO-2026-0001", ["ARC-PO-2026-0001-R3", "ARC-PO-2026-0001"]), "ARC-PO-2026-0001-R4");
});

function appFor(opts: { enabled?: boolean; role?: string; forbidden?: boolean; notify?: (k: string, t: string) => Promise<void> } = {}) {
  const docs: MemoryReissueDoc[] = [
    { id: 1, documentNumber: "ARC-PO-2026-0001", baseDocumentNumber: null, issueKey: "LB-1",
      templateType: "purchase_order", templateVersionId: 10, formData: { PROJECT_TITLE: "旧" },
      lifecycleStatus: "final", isPrimary: true },
    { id: 2, documentNumber: "ARC-PO-2026-0002", baseDocumentNumber: null, issueKey: null as unknown as string,
      templateType: "purchase_order", templateVersionId: 10, formData: {}, lifecycleStatus: "voided", isPrimary: false },
    // 同系列だが別種（検収書）。発注書の再発行で正本フラグを巻き込まれないこと（P1-5）。
    { id: 3, documentNumber: "ARC-INS-2026-0001", baseDocumentNumber: "ARC-PO-2026-0001", issueKey: "LB-1",
      templateType: "inspection_certificate", templateVersionId: 11, formData: {}, lifecycleStatus: "final", isPrimary: true }
  ];
  const events: MemoryReissueEvent[] = [
    { id: 100, documentId: 1, voidedAt: null, voidReason: null },
    { id: 101, documentId: 1, voidedAt: null, voidReason: null }
  ];
  const repository = new MemoryDocumentReissueRepository(docs, events, opts.forbidden ?? false);
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.currentUser = { email: "u@arclight.co.jp", subject: "t", role: opts.role ?? "admin", source: "test" } as never;
    next();
  });
  app.use("/api/v2", createDocumentReissueRouter(
    repository, opts.enabled ?? false, opts.notify,
    opts.notify ? async () => "LB-1" : undefined
  ));
  return { app, repository, docs, events };
}

test("reissue: 書込み無効時は503", async () => {
  const res = await request(appFor({ enabled: false }).app)
    .post("/api/v2/documents/1/reissue").send({ confirmation: "COMMIT_DOCUMENT_REISSUE" });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "DOCUMENT_REISSUE_WRITE_UNAVAILABLE");
});

test("reissue: admin/legal 以外は403", async () => {
  const res = await request(appFor({ enabled: true, role: "requester" }).app)
    .post("/api/v2/documents/1/reissue").send({ confirmation: "COMMIT_DOCUMENT_REISSUE" });
  assert.equal(res.status, 403);
});

test("reissue: 確認トークン不正は400", async () => {
  const res = await request(appFor({ enabled: true }).app)
    .post("/api/v2/documents/1/reissue").send({ confirmation: "WRONG" });
  assert.equal(res.status, 400);
});

test("reissue: 新版を採番し旧版を reissued に倒して実績を新版へ引き継ぐ（残高不変・P0-1）", async () => {
  const posted: string[] = [];
  const target = appFor({ enabled: true, notify: async (_k, t) => { posted.push(t); } });
  const res = await request(target.app).post("/api/v2/documents/1/reissue")
    .send({ confirmation: "COMMIT_DOCUMENT_REISSUE", reason: "誤記訂正" });
  assert.equal(res.status, 200);
  assert.equal(res.body.newNumber, "ARC-PO-2026-0001-R1");
  assert.equal(res.body.carriedEvents, 2);
  // 実績は void されず（voidedAt は null のまま）新版の文書へ付け替わる＝残高不変
  const newDocId = res.body.newId as number;
  for (const e of target.events) {
    assert.equal(e.voidedAt, null);
    assert.equal(e.documentId, newDocId);
  }
  // 旧版は reissued・非正本、新版は final・正本
  const source = target.docs.find((d) => d.id === 1)!;
  assert.equal(source.lifecycleStatus, "reissued");
  assert.equal(source.isPrimary, false);
  assert.equal(source.supersededBy, "ARC-PO-2026-0001-R1");
  const created = target.docs.find((d) => d.documentNumber === "ARC-PO-2026-0001-R1")!;
  assert.equal(created.isPrimary, true);
  assert.equal(created.lifecycleStatus, "final");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(posted.length, 1);
  assert.match(posted[0], /誤記訂正/);
});

test("reissue: 同系列でも別種の文書は正本のまま（template_type 単位の降格・P1-5）", async () => {
  const target = appFor({ enabled: true });
  await request(target.app).post("/api/v2/documents/1/reissue")
    .send({ confirmation: "COMMIT_DOCUMENT_REISSUE", reason: "誤記訂正" }).expect(200);
  const inspection = target.docs.find((d) => d.id === 3)!;
  assert.equal(inspection.isPrimary, true);   // 検収書の正本フラグは維持
  assert.equal(inspection.lifecycleStatus, "final");
});

test("reissue: 存在しない文書は404", async () => {
  const res = await request(appFor({ enabled: true }).app)
    .post("/api/v2/documents/999/reissue").send({ confirmation: "COMMIT_DOCUMENT_REISSUE" });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "DOCUMENT_REISSUE_NOT_FOUND");
});

test("reissue: 無効化済み文書は409", async () => {
  const res = await request(appFor({ enabled: true }).app)
    .post("/api/v2/documents/2/reissue").send({ confirmation: "COMMIT_DOCUMENT_REISSUE" });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "DOCUMENT_REISSUE_SOURCE_VOIDED");
});

test("reissue: 権限未整備(FORBIDDEN_DB)は503", async () => {
  const res = await request(appFor({ enabled: true, forbidden: true }).app)
    .post("/api/v2/documents/1/reissue").send({ confirmation: "COMMIT_DOCUMENT_REISSUE" });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "DOCUMENT_REISSUE_FORBIDDEN_DB");
});
