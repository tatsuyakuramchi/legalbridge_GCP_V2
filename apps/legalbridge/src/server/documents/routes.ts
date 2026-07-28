import { Router } from "express";
import Handlebars from "handlebars";
import { z } from "zod";
import type { DraftRepository } from "./draft-repository.js";
import { DraftConflictError } from "./draft-repository.js";
import type { TemplateRepository } from "./template-repository.js";
import { buildDocumentFormContext, validateDocumentForm } from "./form-mapper.js";
import { buildRenderContext, registerLegacyHelpers } from "./rendering.js";

const saveDraftSchema = z.object({
  templateType: z.string().min(1),
  formData: z.record(z.string(), z.unknown()),
  documentNumber: z.string().trim().min(1).nullable().optional(),
  updatedBy: z.string().email().nullable().optional(),
  expectedUpdatedAt: z.string().datetime().nullable().optional()
});

const validateSchema = z.object({
  templateKey: z.string().min(1),
  templateVersionId: z.number().int().positive(),
  formData: z.record(z.string(), z.unknown())
});

const previewSchema = validateSchema;

export function createDocumentRouter(
  templates: TemplateRepository,
  drafts: DraftRepository
) {
  const router = Router();

  router.get("/document-templates", async (_request, response, next) => {
    try {
      response.json({ templates: await templates.list() });
    } catch (error) {
      next(error);
    }
  });

  router.get("/document-templates/:templateKey/form-schema", async (request, response, next) => {
    try {
      const schema = await templates.findCurrent(request.params.templateKey);
      if (!schema) return response.status(404).json({ error: "template not found" });
      response.json(schema);
    } catch (error) {
      next(error);
    }
  });

  router.get("/document-form-context", async (request, response, next) => {
    try {
      const templateKey = String(request.query.template_key ?? "");
      const issueKey = String(request.query.issue_key ?? "");
      if (!templateKey || !issueKey) {
        return response.status(400).json({ error: "template_key and issue_key are required" });
      }
      const schema = await templates.findCurrent(templateKey);
      if (!schema) return response.status(404).json({ error: "template not found" });
      const draft = await drafts.find(issueKey, templateKey);
      const today = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Tokyo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).format(new Date());
      const formData = buildDocumentFormContext(
        schema,
        { auto: { today }, backlog: { issueKey } },
        draft?.formData ?? {}
      );
      response.json({ schema, draft, formData });
    } catch (error) {
      next(error);
    }
  });

  router.get("/document-drafts/:issueKey", async (request, response, next) => {
    try {
      const templateType = String(request.query.template_type ?? "");
      if (!templateType) return response.status(400).json({ error: "template_type is required" });
      const draft = await drafts.find(request.params.issueKey, templateType);
      if (!draft) return response.status(404).json({ error: "draft not found" });
      response.json({ draft });
    } catch (error) {
      next(error);
    }
  });

  router.put("/document-drafts/:issueKey", async (request, response, next) => {
    try {
      const input = saveDraftSchema.parse(request.body);
      const schema = await templates.findCurrent(input.templateType);
      if (!schema) return response.status(404).json({ error: "template not found" });
      response.json({
        draft: await drafts.save({ issueKey: request.params.issueKey, ...input })
      });
    } catch (error) {
      if (error instanceof DraftConflictError) {
        return response.status(409).json({ error: error.message, current: error.current });
      }
      if (error instanceof z.ZodError) {
        return response.status(400).json({ error: "invalid request", issues: error.issues });
      }
      next(error);
    }
  });

  router.delete("/document-drafts/:issueKey", async (request, response, next) => {
    try {
      const templateType = String(request.query.template_type ?? "");
      if (!templateType) return response.status(400).json({ error: "template_type is required" });
      response.json({
        ok: true,
        removed: await drafts.remove(request.params.issueKey, templateType)
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/documents/validate", async (request, response, next) => {
    try {
      const input = validateSchema.parse(request.body);
      const schema = await templates.findCurrent(input.templateKey);
      if (!schema) return response.status(404).json({ error: "template not found" });
      if (schema.templateVersionId !== input.templateVersionId) {
        return response.status(409).json({
          error: "template version changed",
          currentTemplateVersionId: schema.templateVersionId
        });
      }
      const errors = validateDocumentForm(schema.fields, input.formData);
      response.status(errors.length ? 422 : 200).json({ ok: errors.length === 0, errors });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return response.status(400).json({ error: "invalid request", issues: error.issues });
      }
      next(error);
    }
  });

  router.post("/documents/preview", async (request, response, next) => {
    try {
      const input = previewSchema.parse(request.body);
      const template = await templates.findRenderSource(input.templateKey);
      if (!template) return response.status(404).json({ error: "template not found" });
      if (template.templateVersionId !== input.templateVersionId) {
        return response.status(409).json({
          error: "template version changed",
          currentTemplateVersionId: template.templateVersionId
        });
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
      response.json({
        templateVersionId: template.templateVersionId,
        partials: Object.keys(partials),
        html: render(buildRenderContext(input.formData))
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return response.status(400).json({ error: "invalid request", issues: error.issues });
      }
      next(error);
    }
  });

  return router;
}
