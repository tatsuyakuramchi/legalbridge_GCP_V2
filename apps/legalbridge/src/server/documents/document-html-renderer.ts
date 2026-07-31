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
  const context = document.templateType === INDIVIDUAL_LICENSE_V3_KEY
    ? buildIndividualLicenseV3Context(document.formData)
    : buildTemplateDocumentContext(document.templateType, document.formData);
  const rendered = render({
    ...context,
    DOCUMENT_NUMBER: document.documentNumber,
    document_number: document.documentNumber,
    issue_key: document.issueKey
  });
  return wrapPrintableHtml(rendered);
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
