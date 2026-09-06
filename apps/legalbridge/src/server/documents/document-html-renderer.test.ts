import assert from "node:assert/strict";
import test from "node:test";
import { renderStoredDocumentHtml, StoredDocumentTemplateVersionError } from "./document-html-renderer.js";
import { MemoryTemplateRepository } from "./template-repository.js";
import type { RegisteredDocument } from "./registry-repository.js";
import type { DocumentFormSchema } from "../../types.js";

// 確定済み文書はテンプレ改訂（現行版の差し替え）後も自分の版で再描画できる（2026-09-04）。
// これまで現行版しか引かなかったため、075/076 のような改訂のたびに既存文書の PDF・Drive 保存・
// CloudSign 送信が「stored document template version is not available」で止まっていた。

const current: DocumentFormSchema = { templateKey: "royalty_statement", templateVersionId: 8, label: "計算書", fields: [] } as DocumentFormSchema;
const statement = {
  id: 1, documentNumber: "ARC-RS-2026-0001", issueKey: "LB-1", templateType: "royalty_statement", templateVersionId: 7,
  title: "", counterparty: "", driveLink: "", createdAt: "2026-09-04T00:00:00Z", createdBy: null,
  formData: { licensee: "株式会社アークライト" }
};

test("文書に刻まれた版（旧版）の HTML で描画し、現行版との不一致で止まらない", async () => {
  const templates = new MemoryTemplateRepository([current], { royalty_statement: "<p>v8 {{licensee}}</p>" });
  templates.versionSources.set(7, "<p>v7 {{licensee}}</p>");
  const html = await renderStoredDocumentHtml(templates, statement);
  assert.match(String(html), /v7 株式会社アークライト/);
  assert.doesNotMatch(String(html), /v8/);
});

test("版の行が無く現行版しか引けないときだけ不一致エラーになる", async () => {
  const templates = new MemoryTemplateRepository([current], { royalty_statement: "<p>v8 {{licensee}}</p>" });
  await assert.rejects(renderStoredDocumentHtml(templates, statement), (error: unknown) =>
    error instanceof StoredDocumentTemplateVersionError && error.storedVersionId === 7 && error.currentVersionId === 8);
  // 版が現行と同じなら従来どおり描ける
  const html = await renderStoredDocumentHtml(templates, { ...statement, templateVersionId: 8 });
  assert.match(String(html), /v8 株式会社アークライト/);
});

// 文書番号の振替（026・document_number_history）：直近の旧番号を PDF に出す。

const freeformTemplates = new MemoryTemplateRepository(
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

function renumbered(previousDocumentNumber: string | null): RegisteredDocument {
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
  const html = await renderStoredDocumentHtml(freeformTemplates, renumbered("OLD-2025-0042"));
  assert.ok(html);
  assert.match(html!, /旧文書番号：OLD-2025-0042/);
  assert.match(html!, /ARC-LG-2026-0100/);
});

test("旧番号がない文書には旧番号表示を追加しない", async () => {
  const html = await renderStoredDocumentHtml(freeformTemplates, renumbered(null));
  assert.ok(html);
  assert.doesNotMatch(html!, /旧文書番号：/);
});
