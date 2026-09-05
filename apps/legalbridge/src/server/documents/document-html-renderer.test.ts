import assert from "node:assert/strict";
import test from "node:test";
import { MemoryTemplateRepository } from "./template-repository.js";
import { renderStoredDocumentHtml } from "./document-html-renderer.js";
import type { RegisteredDocument } from "./registry-repository.js";

const templates = new MemoryTemplateRepository(
  [{
    templateKey: "legal_freeform",
    templateVersionId: 1,
    label: "汎用法務文書",
    fields: []
  }],
  {
    legal_freeform: "<html><body><h1>{{DOCUMENT_NUMBER}}</h1><p>{{title}}</p></body></html>"
  }
);

function document(previousDocumentNumber: string | null): RegisteredDocument {
  return {
    id: 1,
    documentNumber: "ARC-LG-2026-0100",
    previousDocumentNumber,
    issueKey: "LEGAL-999",
    templateType: "legal_freeform",
    templateVersionId: 1,
    title: "テスト文書",
    counterparty: "",
    driveLink: "",
    createdAt: "2026-09-05T00:00:00.000Z",
    createdBy: "legal@example.com",
    formData: { title: "テスト文書" }
  };
}

test("番号振替済み文書は直近の旧番号を描画する", async () => {
  const html = await renderStoredDocumentHtml(templates, document("OLD-2025-0042"));
  assert.ok(html);
  assert.match(html!, /旧文書番号：OLD-2025-0042/);
  assert.match(html!, /ARC-LG-2026-0100/);
});

test("旧番号がない文書には旧番号表示を追加しない", async () => {
  const html = await renderStoredDocumentHtml(templates, document(null));
  assert.ok(html);
  assert.doesNotMatch(html!, /旧文書番号：/);
});
