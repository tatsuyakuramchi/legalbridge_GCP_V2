import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../app.js";
import { MemoryDraftRepository } from "./draft-repository.js";
import { MemoryDocumentRegistryRepository, type RegisteredDocument } from "./registry-repository.js";
import { MemoryDocumentLookupRepository, type MemoryLookupDoc } from "./document-lookup-repository.js";
import { MemoryTemplateRepository } from "./template-repository.js";
import { createIntegrationAdapters } from "../integrations/index.js";
import type { DocumentFormSchema } from "../../types.js";

const schema: DocumentFormSchema = {
  templateKey: "purchase_order", templateVersionId: 10, label: "発注書",
  fields: [{ name: "PROJECT_TITLE", label: "件名", required: true }]
};

function doc(over: Partial<RegisteredDocument> = {}): RegisteredDocument {
  return {
    id: 1, documentNumber: "ARC-PO-2026-0001", issueKey: "LB-1", templateType: "purchase_order",
    templateVersionId: 10, title: "発注A", counterparty: "取引先A", driveLink: "",
    createdAt: "2026-07-01T00:00:00.000Z", createdBy: "legal@example.com",
    lifecycleStatus: "final", formData: { PROJECT_TITLE: "発注A" }, ...over
  };
}

function appFor() {
  const registry = new MemoryDocumentRegistryRepository([
    doc(),
    doc({ id: 2, documentNumber: "ARC-PO-2026-0002", driveLink: "https://drive/x", title: "発注B" }),
    doc({ id: 3, documentNumber: "ARC-PO-2026-0003", lifecycleStatus: "voided", title: "廃止" })
  ]);
  const lookupDocs: MemoryLookupDoc[] = [
    { id: 1, documentNumber: "ARC-PO-2026-0001", issueKey: "LB-1", templateType: "purchase_order", driveLink: "", title: "発注A" },
    { id: 2, documentNumber: "ARC-PO-2026-0002", issueKey: "LB-2", templateType: "purchase_order", driveLink: "https://drive/x" },
    { id: 3, documentNumber: "ARC-PO-2026-0003", issueKey: "LB-3", templateType: "purchase_order", driveLink: "", lifecycleStatus: "voided" }
  ];
  const lookup = new MemoryDocumentLookupRepository(
    lookupDocs,
    { purchase_order: "PO" },
    { [`PO:${new Date().getUTCFullYear()}`]: 41 }
  );
  return createApp({
    templates: new MemoryTemplateRepository([schema]),
    drafts: new MemoryDraftRepository(),
    integrations: createIntegrationAdapters(),
    documentRegistry: registry,
    documentLookup: lookup
  }, { accessMode: "readonly", requireDatabase: false });
}

test("by-number: 文書番号で1件を引く", async () => {
  const res = await request(appFor()).get("/api/v2/documents/by-number/ARC-PO-2026-0001").expect(200);
  assert.equal(res.body.document.id, 1);
  assert.equal(res.body.document.documentNumber, "ARC-PO-2026-0001");
});

test("by-number: 未存在は404", async () => {
  const res = await request(appFor()).get("/api/v2/documents/by-number/NOPE").expect(404);
  assert.equal(res.body.code, "DOCUMENT_NOT_FOUND");
});

test("pending-pdf: Drive未保存かつvoidでない文書のみ・件数集計", async () => {
  const res = await request(appFor()).get("/api/v2/documents/pending-pdf").expect(200);
  assert.equal(res.body.total, 1);                 // id=1 のみ（2はdrive有・3はvoid）
  assert.equal(res.body.rows[0].id, 1);
  assert.equal(res.body.countsByTemplate.purchase_order, 1);
});

test("numbering/next: 非破壊で次番号をプレビュー", async () => {
  const res = await request(appFor()).get("/api/v2/documents/numbering/next?type=purchase_order").expect(200);
  const year = new Date().getUTCFullYear();
  assert.equal(res.body.sequence, 42);             // current 41 → 次 42（増分しない）
  assert.equal(res.body.number, `ARC-PO-${year}-0042`);
});

test("numbering/next: type 未指定は400", async () => {
  const res = await request(appFor()).get("/api/v2/documents/numbering/next").expect(400);
  assert.equal(res.body.code, "NUMBERING_TYPE_REQUIRED");
});

test("numbering/next: プレフィックス未設定の種別は404", async () => {
  const res = await request(appFor()).get("/api/v2/documents/numbering/next?type=unknown_type").expect(404);
  assert.equal(res.body.code, "NUMBERING_PREFIX_MISSING");
});

test("pending-pdf は /documents/:id より先に評価される（誤って詳細取得にならない）", async () => {
  // pending-pdf が :id="pending-pdf" として registry に吸われていないことを確認
  const res = await request(appFor()).get("/api/v2/documents/pending-pdf").expect(200);
  assert.ok(Array.isArray(res.body.rows));
});
