import { Router } from "express";
import { z } from "zod";
import type { DraftRepository } from "./draft-repository.js";
import {
  DocumentFinalizationConflictError,
  type DocumentFinalizationRepository
} from "./finalization-repository.js";
import { validateDocumentForm } from "./form-mapper.js";
import type { TemplateRepository } from "./template-repository.js";

const finalizeSchema = z.object({
  issueKey: z.string().trim().min(1).max(100),
  templateType: z.string().trim().min(1).max(100),
  templateVersionId: z.number().int().positive(),
  formData: z.record(z.string(), z.unknown()),
  expectedDraftUpdatedAt: z.string().datetime(),
  createdBy: z.string().email().nullable().optional()
});

export function createDocumentFinalizationRouter(
  templates: TemplateRepository,
  drafts: DraftRepository,
  finalizations: DocumentFinalizationRepository
) {
  const router = Router();

  router.post("/documents/finalize", async (request, response, next) => {
    try {
      const input = finalizeSchema.parse(request.body);
      const schema = await templates.findCurrent(input.templateType);
      if (!schema) return response.status(404).json({ error: "template not found" });
      if (schema.templateVersionId !== input.templateVersionId) {
        return response.status(409).json({
          error: "template version changed",
          currentTemplateVersionId: schema.templateVersionId
        });
      }

      const errors = validateDocumentForm(schema.fields, input.formData);
      if (errors.length) return response.status(422).json({ error: "validation failed", errors });

      const draft = await drafts.find(input.issueKey, input.templateType);
      if (!draft) return response.status(404).json({ error: "draft not found" });
      if (draft.updatedAt !== input.expectedDraftUpdatedAt) {
        return response.status(409).json({ error: "draft changed", current: draft });
      }

      const document = await finalizations.finalize(input, draft);
      await drafts.remove(input.issueKey, input.templateType);
      response.status(201).json({
        document,
        integrations: {
          pdf: "pending",
          drive: "disabled",
          backlog: "disabled"
        }
      });
    } catch (error) {
      if (error instanceof DocumentFinalizationConflictError) {
        return response.status(409).json({ error: error.message });
      }
      if (error instanceof z.ZodError) {
        return response.status(400).json({ error: "invalid request", issues: error.issues });
      }
      next(error);
    }
  });

  return router;
}
