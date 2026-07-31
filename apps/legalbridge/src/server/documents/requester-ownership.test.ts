import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../app.js";
import { MemoryDraftRepository } from "./draft-repository.js";
import { MemoryDocumentRegistryRepository } from "./registry-repository.js";
import { MemoryPdfRenderer } from "./pdf-renderer.js";
import { MemoryTemplateRepository } from "./template-repository.js";
import { createIntegrationAdapters } from "../integrations/index.js";
import type { DocumentFormSchema } from "../../types.js";

const schema: DocumentFormSchema = {
  templateKey: "purchase_order",
  templateVersionId: 10,
  label: "発注書",
  fields: [{ name: "PROJECT_TITLE", label: "件名", required: true }]
};

const requesterHeaders = {
  "x-goog-authenticated-user-email": "accounts.google.com:requester@example.com",
  "x-goog-authenticated-user-id": "accounts.google.com:requester-subject"
};

async function fixture() {
  const drafts = new MemoryDraftRepository();
  await drafts.save({
    issueKey: "OWN-1",
    templateType: "purchase_order",
    formData: { PROJECT_TITLE: "本人下書き" },
    updatedBy: "requester@example.com"
  });
  await drafts.save({
    issueKey: "OTHER-1",
    templateType: "purchase_order",
    formData: { PROJECT_TITLE: "他人下書き" },
    updatedBy: "other@example.com"
  });
  const documents = new MemoryDocumentRegistryRepository([
    {
      id: 1, documentNumber: "ARC-PO-2026-0001", issueKey: "OWN-1",
      templateType: "purchase_order", templateVersionId: 10,
      title: "本人文書", counterparty: "", driveLink: "",
      createdAt: "2026-07-31T00:00:00.000Z", createdBy: "requester@example.com",
      formData: { PROJECT_TITLE: "本人文書" }
    },
    {
      id: 2, documentNumber: "ARC-PO-2026-0002", issueKey: "OTHER-1",
      templateType: "purchase_order", templateVersionId: 10,
      title: "他人文書", counterparty: "", driveLink: "",
      createdAt: "2026-07-31T00:00:00.000Z", createdBy: "other@example.com",
      formData: { PROJECT_TITLE: "他人文書" }
    }
  ]);
  return {
    drafts,
    app: createApp({
      templates: new MemoryTemplateRepository([schema], { purchase_order: "<main>{{PROJECT_TITLE}}</main>" }),
      drafts,
      integrations: createIntegrationAdapters(),
      documentRegistry: documents,
      pdfRenderer: new MemoryPdfRenderer()
    }, {
      accessMode: "readwrite",
      requireDatabase: false,
      writeFeaturesEnabled: true,
      writeScopes: new Set(["drafts", "pdf"]),
      auth: {
        mode: "iap",
        adminEmails: new Set(),
        legalEmails: new Set(),
        requesterDomains: new Set(["example.com"])
      }
    })
  };
}

test("依頼者の下書き一覧・詳細・保存を本人所有に限定する", async () => {
  const target = await fixture();
  const list = await request(target.app)
    .get("/api/v2/document-drafts")
    .set(requesterHeaders)
    .expect(200);
  assert.deepEqual(list.body.drafts.map((item: { issueKey: string }) => item.issueKey), ["OWN-1"]);

  await request(target.app)
    .get("/api/v2/document-drafts/OTHER-1")
    .query({ template_type: "purchase_order" })
    .set(requesterHeaders)
    .expect(404);

  const saved = await request(target.app)
    .put("/api/v2/document-drafts/NEW-1")
    .set(requesterHeaders)
    .send({
      templateType: "purchase_order",
      formData: { PROJECT_TITLE: "新規" },
      updatedBy: "spoofed@example.com"
    })
    .expect(200);
  assert.equal(saved.body.draft.updatedBy, "requester@example.com");

  await request(target.app)
    .put("/api/v2/document-drafts/OTHER-1")
    .set(requesterHeaders)
    .send({
      templateType: "purchase_order",
      formData: { PROJECT_TITLE: "上書き禁止" }
    })
    .expect(404);
  assert.equal((await target.drafts.find("OTHER-1", "purchase_order"))?.formData.PROJECT_TITLE, "他人下書き");
});

test("依頼者の確定文書をcreated_byで限定しPDFと案件を閉じる", async () => {
  const target = await fixture();
  const list = await request(target.app)
    .get("/api/v2/documents")
    .set(requesterHeaders)
    .expect(200);
  assert.deepEqual(list.body.documents.map((item: { id: number }) => item.id), [1]);

  await request(target.app).get("/api/v2/documents/1").set(requesterHeaders).expect(200);
  await request(target.app).get("/api/v2/documents/2").set(requesterHeaders).expect(404);

  const pdf = await request(target.app)
    .get("/api/v2/documents/1/pdf")
    .set(requesterHeaders)
    .expect(403);
  assert.equal(pdf.body.code, "ROLE_FORBIDDEN");

  await request(target.app).get("/api/v2/matters").set(requesterHeaders).expect(403);
});
