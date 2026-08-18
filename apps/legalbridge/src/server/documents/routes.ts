import { Router, type Response } from "express";
import Handlebars from "handlebars";
import { z } from "zod";
import type { DraftRepository } from "./draft-repository.js";
import { DraftConflictError } from "./draft-repository.js";
import type { TemplateRepository } from "./template-repository.js";
import { buildDocumentFormContext, validateDocumentForm } from "./form-mapper.js";
import { registerLegacyHelpers } from "./rendering.js";
import { buildIndividualLicenseV3Context, INDIVIDUAL_LICENSE_V3_KEY } from "./individual-license-v3.js";
import { inspectTemplateCompatibility } from "./compatibility.js";
import { buildTemplateDocumentContext } from "./template-context-adapters.js";

const saveDraftSchema = z.object({
  templateType: z.string().min(1),
  formData: z.record(z.string(), z.unknown()),
  documentNumber: z.string().trim().min(1).nullable().optional(),
  updatedBy: z.string().email().nullable().optional(),
  expectedUpdatedAt: z.string().datetime().nullable().optional()
});

const draftListQuerySchema = z.object({
  q: z.string().trim().max(100).optional().default(""),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50)
});

const validateSchema = z.object({
  templateKey: z.string().min(1),
  templateVersionId: z.number().int().positive(),
  formData: z.record(z.string(), z.unknown())
});

const previewSchema = validateSchema;

export function createDocumentRouter(
  templates: TemplateRepository,
  drafts: DraftRepository,
  draftListingEnabled = false
) {
  const router = Router();

  router.get("/document-templates", async (_request, response, next) => {
    try {
      response.json({ templates: await templates.list() });
    } catch (error) {
      next(error);
    }
  });

  router.get("/document-templates/compatibility-report", async (_request, response, next) => {
    try {
      const [schemas, partials] = await Promise.all([templates.list(), templates.findPartials()]);
      const reports = await Promise.all(schemas.map(async (schema) => {
        const source = await templates.findRenderSource(schema.templateKey);
        return source ? inspectTemplateCompatibility(schema, source.htmlSource, partials) : {
          templateKey: schema.templateKey, label: schema.label, fieldCount: schema.fields.length,
          status: "error" as const, variables: [], helpers: [], partials: [],
          missingHelpers: [], missingPartials: [], unmappedVariables: [],
          renderError: "current template source not found"
        };
      }));
      response.json({
        summary: {
          total: reports.length,
          ok: reports.filter((item) => item.status === "ok").length,
          warning: reports.filter((item) => item.status === "warning").length,
          error: reports.filter((item) => item.status === "error").length
        },
        reports
      });
    } catch (error) { next(error); }
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
      const foundDraft = await drafts.find(issueKey, templateKey);
      const owner = requesterEmail(response);
      const draft = foundDraft && owns(foundDraft.updatedBy, owner) ? foundDraft : null;
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

  router.get("/document-drafts", async (request, response, next) => {
    try {
      if (!draftListingEnabled) {
        return response.status(403).json({
          error: "draft workspace is not enabled",
          code: "DRAFT_WORKSPACE_DISABLED"
        });
      }
      const query = draftListQuerySchema.parse(request.query);
      const owner = requesterEmail(response);
      const listed = await drafts.list(query.q, owner ? 100 : query.limit);
      response.json({ drafts: listed.filter((draft) => owns(draft.updatedBy, owner)).slice(0, query.limit) });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return response.status(400).json({ error: "invalid request", issues: error.issues });
      }
      next(error);
    }
  });

  // 古い下書きの一括整理（Phase 4）。更新から days 日以上経過した下書きを
  // 一覧（プレビュー）／一括削除する。requester は自分の下書きのみ、admin/legal は全件。
  // 実行(POST)は safe-write ミドルウェアで draftWriteEnabled ゲート済。
  router.get("/document-drafts/stale", async (request, response, next) => {
    try {
      if (!draftListingEnabled) {
        return response.status(403).json({ error: "draft workspace is not enabled", code: "DRAFT_WORKSPACE_DISABLED" });
      }
      const { days } = z.object({ days: z.coerce.number().int().min(1).max(3650).default(30) }).parse(request.query);
      const owner = requesterEmail(response);
      const stale = await drafts.listStale(days, owner, 200);
      response.json({ days, count: stale.length, drafts: stale });
    } catch (error) {
      if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
      next(error);
    }
  });

  router.post("/document-drafts/purge", async (request, response, next) => {
    try {
      if (!draftListingEnabled) {
        return response.status(403).json({ error: "draft workspace is not enabled", code: "DRAFT_WORKSPACE_DISABLED" });
      }
      const { days } = z.object({ days: z.coerce.number().int().min(1).max(3650) }).parse(request.body);
      const owner = requesterEmail(response);
      const purgedCount = await drafts.purgeStale(days, owner);
      response.json({ ok: true, purgedCount, days });
    } catch (error) {
      if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
      next(error);
    }
  });

  router.get("/document-drafts/:issueKey", async (request, response, next) => {
    try {
      const templateType = String(request.query.template_type ?? "");
      if (!templateType) return response.status(400).json({ error: "template_type is required" });
      const draft = await drafts.find(request.params.issueKey, templateType);
      if (!draft || !owns(draft.updatedBy, requesterEmail(response))) return response.status(404).json({ error: "draft not found" });
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
      const owner = requesterEmail(response);
      const existing = owner ? await drafts.find(request.params.issueKey, input.templateType) : null;
      if (existing && !owns(existing.updatedBy, owner)) {
        return response.status(404).json({ error: "draft not found" });
      }
      const actor = response.locals.currentUser!;
      response.json({
        draft: await drafts.save({
          issueKey: request.params.issueKey,
          ...input,
          updatedBy: actor.source === "iap" ? actor.email : input.updatedBy
        })
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
      const owner = requesterEmail(response);
      const existing = await drafts.find(request.params.issueKey, templateType);
      if (!existing || !owns(existing.updatedBy, owner)) {
        return response.status(404).json({ error: "draft not found" });
      }
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
      const errors = validateDocumentForm(schema.templateKey, schema.fields, input.formData);
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
        html: render(input.templateKey === INDIVIDUAL_LICENSE_V3_KEY
          ? buildIndividualLicenseV3Context(input.formData)
          : buildTemplateDocumentContext(input.templateKey, input.formData))
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

function requesterEmail(response: Response) {
  const user = response.locals.currentUser;
  return user?.role === "requester" ? user.email.toLowerCase() : "";
}

function owns(recordEmail: string | null | undefined, requiredOwner: string) {
  return !requiredOwner || recordEmail?.toLowerCase() === requiredOwner;
}
