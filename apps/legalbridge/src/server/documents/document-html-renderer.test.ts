import assert from "node:assert/strict";
import test from "node:test";
import { renderStoredDocumentHtml, StoredDocumentTemplateVersionError } from "./document-html-renderer.js";
import { MemoryTemplateRepository } from "./template-repository.js";
import type { DocumentFormSchema } from "../../types.js";

// 確定済み文書はテンプレ改訂（現行版の差し替え）後も自分の版で再描画できる（2026-09-04）。
// これまで現行版しか引かなかったため、075/076 のような改訂のたびに既存文書の PDF・Drive 保存・
// CloudSign 送信が「stored document template version is not available」で止まっていた。

const current: DocumentFormSchema = { templateKey: "royalty_statement", templateVersionId: 8, label: "計算書", fields: [] } as DocumentFormSchema;
const document = {
  id: 1, documentNumber: "ARC-RS-2026-0001", issueKey: "LB-1", templateType: "royalty_statement", templateVersionId: 7,
  title: "", counterparty: "", driveLink: "", createdAt: "2026-09-04T00:00:00Z", createdBy: null,
  formData: { licensee: "株式会社アークライト" }
};

test("文書に刻まれた版（旧版）の HTML で描画し、現行版との不一致で止まらない", async () => {
  const templates = new MemoryTemplateRepository([current], { royalty_statement: "<p>v8 {{licensee}}</p>" });
  templates.versionSources.set(7, "<p>v7 {{licensee}}</p>");
  const html = await renderStoredDocumentHtml(templates, document);
  assert.match(String(html), /v7 株式会社アークライト/);
  assert.doesNotMatch(String(html), /v8/);
});

test("版の行が無く現行版しか引けないときだけ不一致エラーになる", async () => {
  const templates = new MemoryTemplateRepository([current], { royalty_statement: "<p>v8 {{licensee}}</p>" });
  await assert.rejects(renderStoredDocumentHtml(templates, document), (error: unknown) =>
    error instanceof StoredDocumentTemplateVersionError && error.storedVersionId === 7 && error.currentVersionId === 8);
  // 版が現行と同じなら従来どおり描ける
  const html = await renderStoredDocumentHtml(templates, { ...document, templateVersionId: 8 });
  assert.match(String(html), /v8 株式会社アークライト/);
});
