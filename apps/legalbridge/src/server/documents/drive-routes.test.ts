import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../app.js";
import { MemoryDraftRepository } from "./draft-repository.js";
import { MemoryDocumentRegistryRepository } from "./registry-repository.js";
import { MemoryDriveStorage } from "./drive-storage.js";
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

function dependencies() {
  const documents = new MemoryDocumentRegistryRepository([{
    id: 3,
    documentNumber: "ARC-PR-2026-0002",
    issueKey: "VALIDATION-3",
    templateType: "purchase_order",
    templateVersionId: 10,
    title: "Drive保存テスト",
    counterparty: "取引先A",
    driveLink: "",
    createdAt: "2026-07-31T00:00:00.000Z",
    createdBy: "legal@example.com",
    formData: { PROJECT_TITLE: "Drive保存テスト" }
  }]);
  const drive = new MemoryDriveStorage();
  return {
    documents,
    drive,
    app: createApp({
      templates: new MemoryTemplateRepository(
        [schema],
        { purchase_order: "<main>{{PROJECT_TITLE}}</main>" }
      ),
      drafts: new MemoryDraftRepository(),
      integrations: createIntegrationAdapters(),
      documentRegistry: documents,
      pdfRenderer: new MemoryPdfRenderer(),
      driveStorage: drive
    }, {
      accessMode: "readwrite",
      requireDatabase: false,
      writeFeaturesEnabled: true,
      writeScopes: new Set(["drive"])
    })
  };
}

test("Drive capabilityでPDFを保存し文書リンクを更新する", async () => {
  const target = dependencies();
  const response = await request(target.app)
    .post("/api/v2/documents/3/drive")
    .expect(201);

  assert.equal(response.body.reused, false);
  assert.match(response.body.driveLink, /^https:\/\/drive\.google\.com\//);
  assert.equal(target.drive.uploads, 1);
  assert.equal((await target.documents.find(3))?.driveLink, response.body.driveLink);

  const runtime = await request(target.app).get("/api/v2/runtime").expect(200);
  assert.deepEqual(runtime.body.writeCapabilities, ["drive"]);
});

test("保存済み文書は再アップロードせず既存リンクを返す", async () => {
  const target = dependencies();
  await request(target.app).post("/api/v2/documents/3/drive").expect(201);
  const repeated = await request(target.app)
    .post("/api/v2/documents/3/drive")
    .expect(200);

  assert.equal(repeated.body.reused, true);
  assert.equal(target.drive.uploads, 1);
});

test("drive scopeなしではDrive保存を拒否する", async () => {
  const target = dependencies();
  const blocked = createApp({
    templates: new MemoryTemplateRepository([schema]),
    drafts: new MemoryDraftRepository(),
    integrations: createIntegrationAdapters(),
    documentRegistry: target.documents,
    pdfRenderer: new MemoryPdfRenderer(),
    driveStorage: target.drive
  }, {
    accessMode: "readwrite",
    requireDatabase: false,
    writeFeaturesEnabled: true,
    writeScopes: new Set()
  });

  const response = await request(blocked)
    .post("/api/v2/documents/3/drive")
    .expect(403);
  assert.equal(response.body.code, "WRITE_SCOPE_DISABLED");
  assert.equal(target.drive.uploads, 0);
});
