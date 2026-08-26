import { Router } from "express";
import { z } from "zod";
import type { DraftRepository } from "./draft-repository.js";
import {
  DocumentFinalizationConflictError,
  type DocumentFinalizationRepository
} from "./finalization-repository.js";
import { validateDocumentForm } from "./form-mapper.js";
import type { TemplateRepository } from "./template-repository.js";
import { buildDocumentConditionInputs, hasConditionSyncData } from "./condition-sync.js";
import type { ConditionSyncRepository } from "./condition-sync-repository.js";

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
  finalizations: DocumentFinalizationRepository,
  // 条件明細（condition_lines）の台帳同期。未指定なら従来どおり documents 行のみ。
  conditionSync?: ConditionSyncRepository
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

      const errors = validateDocumentForm(schema.templateKey, schema.fields, input.formData);
      if (errors.length) return response.status(422).json({ error: "validation failed", errors });

      const draft = await drafts.find(input.issueKey, input.templateType);
      if (!draft) return response.status(404).json({ error: "draft not found" });
      if (draft.updatedAt !== input.expectedDraftUpdatedAt) {
        return response.status(409).json({ error: "draft changed", current: draft });
      }

      const actor = response.locals.currentUser!;
      const document = await finalizations.finalize({
        ...input,
        createdBy: actor.source === "iap" ? actor.email : input.createdBy
      }, draft);
      await drafts.remove(input.issueKey, input.templateType);

      // 条件明細の台帳同期（V1 の確定時 upsert 相当）。文書の確定自体は成立させ、
      // 同期失敗は警告として返す＝手動同期（/documents/:id/conditions/sync）で回復できる。
      let conditionSyncResult: { written: number; deleted: number } | null = null;
      let conditionSyncWarning: string | undefined;
      if (conditionSync && hasConditionSyncData(input.formData)) {
        try {
          const synced = await conditionSync.upsertDocumentConditions(
            document.id, buildDocumentConditionInputs(input.formData)
          );
          conditionSyncResult = { written: synced.written, deleted: synced.deleted };
        } catch (error) {
          conditionSyncWarning = (error as { code?: string })?.code === "42501"
            ? "条件明細の台帳同期権限が未付与です（grant 066）。適用後、文書詳細の「条件明細を台帳へ同期」で反映できます"
            : `条件明細の台帳同期に失敗しました（文書詳細から再同期できます）: ${String((error as Error)?.message ?? error).slice(0, 200)}`;
        }
      }

      response.status(201).json({
        document,
        integrations: {
          pdf: "pending",
          drive: "disabled",
          backlog: "disabled",
          conditions: conditionSyncResult ? "synced" : conditionSyncWarning ? "warning" : "none"
        },
        ...(conditionSyncResult ? { conditionSync: conditionSyncResult } : {}),
        ...(conditionSyncWarning ? { conditionSyncWarning } : {})
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
