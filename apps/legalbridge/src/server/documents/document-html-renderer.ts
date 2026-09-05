import Handlebars from "handlebars";
import type { TemplateRepository } from "./template-repository.js";
import type { RegisteredDocument } from "./registry-repository.js";
import { registerLegacyHelpers } from "./rendering.js";
import {
  buildIndividualLicenseV3Context,
  INDIVIDUAL_LICENSE_V3_KEY
} from "./individual-license-v3.js";
import { buildTemplateDocumentContext } from "./template-context-adapters.js";

export class StoredDocumentTemplateVersionError extends Error {
  constructor(
    readonly storedVersionId: number | null,
    readonly currentVersionId: number
  ) {
    super("stored document template version is not available");
  }
}

export async function renderStoredDocumentHtml(
  templates: TemplateRepository,
  document: RegisteredDocument
) {
  const template = await templates.findRenderSource(document.templateType);
  if (!template) return null;
  if (
    document.templateVersionId !== null &&
    document.templateVersionId !== template.templateVersionId
  ) {
    throw new StoredDocumentTemplateVersionError(
      document.templateVersionId,
      template.templateVersionId
    );
  }

  const handlebars = Handlebars.create();
  registerLegacyHelpers(handlebars);
  const partials = await templates.findPartials();
  for (const [name, source] of Object.entries(partials)) {
    handlebars.registerPartial(name, source);
  }
  const render = handlebars.compile(template.htmlSource, {
    strict: false,
    noEscape: false
  });
  const previousDocumentNumber =
    document.previousDocumentNumber ??
    firstText(document.formData, [
      "PREVIOUS_DOCUMENT_NUMBER", "旧文書番号", "旧契約書番号",
      "BASE_DOC_NO", "元文書番号", "元契約番号",
      "previousDocumentNumber", "baseDocumentNumber", "originalDocumentNumber"
    ]) ??
    null;
  const numberedFormData = {
    ...document.formData,
    契約書番号: document.documentNumber,
    文書番号: document.documentNumber,
    CONTRACT_NO: document.documentNumber,
    DOC_NO: document.documentNumber,
    document_number: document.documentNumber,
    PREVIOUS_DOCUMENT_NUMBER: previousDocumentNumber,
    旧文書番号: previousDocumentNumber,
    旧契約書番号: previousDocumentNumber,
    BASE_DOC_NO: document.formData.BASE_DOC_NO ?? previousDocumentNumber,
    isReissue: document.formData.isReissue ?? Boolean(previousDocumentNumber),
    showReissueBanner: document.formData.showReissueBanner ?? Boolean(previousDocumentNumber)
  };
  const context = document.templateType === INDIVIDUAL_LICENSE_V3_KEY
    ? buildIndividualLicenseV3Context(numberedFormData)
    : buildTemplateDocumentContext(document.templateType, numberedFormData);
  const rendered = render({
    ...context,
    DOCUMENT_NUMBER: document.documentNumber,
    PREVIOUS_DOCUMENT_NUMBER: previousDocumentNumber,
    previous_document_number: previousDocumentNumber,
    document_number: document.documentNumber,
    issue_key: document.issueKey
  });
  return wrapPrintableHtml(injectPreviousNumberNotice(rendered, previousDocumentNumber));
}

function firstText(values: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = values[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function injectPreviousNumberNotice(source: string, previousDocumentNumber: string | null) {
  if (!previousDocumentNumber || source.includes(previousDocumentNumber)) return source;
  const escaped = escapeHtml(previousDocumentNumber);
  const notice =
    `<div class="lb-previous-document-number" style="text-align:right;font-size:9pt;margin:0 0 4mm;color:#475569;">旧文書番号：${escaped}</div>`;
  if (/<body[^>]*>/i.test(source)) {
    return source.replace(/<body([^>]*)>/i, (match) => `${match}${notice}`);
  }
  return `${notice}${source}`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function wrapPrintableHtml(source: string) {
  if (/<html[\s>]/i.test(source)) return source;
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <style>
    @page { size: A4; margin: 14mm; }
    html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body { margin: 0; font-family: "Noto Sans CJK JP", "Noto Serif CJK JP", sans-serif; }
  </style>
</head>
<body>${source}</body>
</html>`;
}
