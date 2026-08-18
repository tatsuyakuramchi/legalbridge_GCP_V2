import type { Router } from "express";
import { Router as createRouter } from "express";
import type { DocumentFormData, DocumentFormSchema, TemplateField } from "../../types.js";
import { inspectTemplateCompatibility } from "./compatibility.js";
import { renderStoredDocumentHtml } from "./document-html-renderer.js";
import { validateDocumentForm } from "./form-mapper.js";
import type { RegisteredDocument } from "./registry-repository.js";
import type { TemplateRepository } from "./template-repository.js";

export interface TemplateRegressionItem {
  templateKey: string;
  templateVersionId: number;
  label: string;
  status: "ok" | "warning" | "error";
  checks: {
    renderSource: boolean;
    compatibility: boolean;
    validation: boolean;
    htmlRender: boolean;
  };
  missingHelpers: string[];
  missingPartials: string[];
  unmappedVariables: string[];
  validationErrors: Array<{ field: string; message: string }>;
  renderedBytes: number;
  error?: string;
}

export interface TemplateRegressionReport {
  summary: { total: number; passed: number; warnings: number; failed: number };
  templates: TemplateRegressionItem[];
}

export async function runTemplateRegression(
  repository: TemplateRepository
): Promise<TemplateRegressionReport> {
  const schemas = await repository.list();
  const partials = await repository.findPartials();
  const templates: TemplateRegressionItem[] = [];

  for (const schema of schemas) {
    templates.push(await inspectOne(repository, schema, partials));
  }

  return {
    summary: {
      total: templates.length,
      passed: templates.filter((item) => item.status !== "error").length,
      warnings: templates.filter((item) => item.status === "warning").length,
      failed: templates.filter((item) => item.status === "error").length
    },
    templates
  };
}

export function createTemplateRegressionRouter(repository: TemplateRepository): Router {
  const router = createRouter();
  router.get("/admin/template-regression", async (_request, response, next) => {
    try {
      response.json(await runTemplateRegression(repository));
    } catch (error) {
      next(error);
    }
  });
  return router;
}

async function inspectOne(
  repository: TemplateRepository,
  schema: DocumentFormSchema,
  partials: Record<string, string>
): Promise<TemplateRegressionItem> {
  const base = {
    templateKey: schema.templateKey,
    templateVersionId: schema.templateVersionId,
    label: schema.label,
    missingHelpers: [] as string[],
    missingPartials: [] as string[],
    unmappedVariables: [] as string[],
    validationErrors: [] as Array<{ field: string; message: string }>,
    renderedBytes: 0
  };

  try {
    const source = await repository.findRenderSource(schema.templateKey);
    if (!source) {
      return failure(base, "current template render source is missing");
    }
    if (source.templateVersionId !== schema.templateVersionId) {
      return failure(base, "listed template version does not match render source");
    }

    const formData = Object.fromEntries(
      schema.fields.map((field) => [field.name, sampleValue(field)])
    ) as DocumentFormData;
    const validationErrors = validateDocumentForm(schema.templateKey, schema.fields, formData);
    const compatibility = inspectTemplateCompatibility(schema, source.htmlSource, partials);
    const rendered = await renderStoredDocumentHtml(
      repository,
      regressionDocument(schema, formData)
    );
    const renderedBytes = rendered ? Buffer.byteLength(rendered, "utf8") : 0;
    const htmlRender = renderedBytes > 0;
    const hasError = compatibility.status === "error" ||
      validationErrors.length > 0 ||
      !htmlRender;
    const hasWarning = compatibility.status === "warning";

    return {
      ...base,
      status: hasError ? "error" : hasWarning ? "warning" : "ok",
      checks: {
        renderSource: true,
        compatibility: compatibility.status !== "error",
        validation: validationErrors.length === 0,
        htmlRender
      },
      missingHelpers: compatibility.missingHelpers,
      missingPartials: compatibility.missingPartials,
      unmappedVariables: compatibility.unmappedVariables,
      validationErrors,
      renderedBytes,
      ...(compatibility.renderError ? { error: compatibility.renderError } : {})
    };
  } catch (error) {
    return failure(base, error instanceof Error ? error.message : String(error));
  }
}

function failure(
  base: Omit<TemplateRegressionItem, "status" | "checks">,
  error: string
): TemplateRegressionItem {
  return {
    ...base,
    status: "error",
    checks: {
      renderSource: false,
      compatibility: false,
      validation: false,
      htmlRender: false
    },
    error
  };
}

function regressionDocument(
  schema: DocumentFormSchema,
  formData: DocumentFormData
): RegisteredDocument {
  return {
    id: 0,
    documentNumber: "ARC-REGRESSION-2026-0001",
    issueKey: "REGRESSION-READONLY",
    templateType: schema.templateKey,
    templateVersionId: schema.templateVersionId,
    title: schema.label,
    counterparty: "回帰検査用取引先",
    driveLink: "",
    createdAt: "2026-08-01T00:00:00.000Z",
    createdBy: "template-regression@local",
    formData
  };
}

function sampleValue(field: TemplateField): unknown {
  if (field.type === "boolean") return true;
  if (field.type === "number") return 1;
  if (field.type === "date") return "2026-08-01";
  if (field.type === "select") return field.options?.[0] ?? "検証値";
  return `REGRESSION_${field.name}`;
}
