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
import { royaltyEventInputFromStatement } from "../royalty/statement-event.js";
import { calculateFee } from "../../royalty/calc.js";
import type { RoyaltyEventRepository } from "../royalty/event-repository.js";
import type { ConditionLedgerRepository } from "../conditions/ledger-repository.js";

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
  conditionSync?: ConditionSyncRepository,
  // 利用許諾料計算書の確定時の消化イベント自動記帳（V1 syncRoyaltyCalcEvent 相当）。
  // royalty-events スコープが有効なときだけ渡される。
  royaltyEvents?: { repository: RoyaltyEventRepository; enabled: boolean },
  // 条件台帳（condition_ledger）。form_data.condition_ledger_id を持つ文書は台帳から起こした
  // 文書＝確定時に条件を作り直さず、台帳へ文書を紐づけるだけ（二重防止・2026-09-04）。
  conditionLedgers?: ConditionLedgerRepository
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
      let ledgerLinked: { id: number; documentNumber: string | null } | null = null;
      const ledgerId = Number(input.formData.condition_ledger_id);
      if (Number.isInteger(ledgerId) && ledgerId > 0) {
        // 台帳起点の文書：条件明細は台帳（CT-…）に既にある。文書番号を台帳へ結び付けるだけ。
        if (conditionLedgers) {
          try {
            const linked = await conditionLedgers.attach(ledgerId, document.id);
            ledgerLinked = { id: ledgerId, documentNumber: linked.documentNumber };
          } catch (error) {
            conditionSyncWarning = `条件台帳への紐づけに失敗しました（条件台帳の画面から「過去文書に紐づける」で回復できます）: ${String((error as Error)?.message ?? error).slice(0, 200)}`;
          }
        }
      } else if (conditionSync && hasConditionSyncData(input.formData)) {
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

      // 計算書の消化イベント自動記帳（単票＋条件明細ひも付けありのみ・サーバ再計算値）。
      // 失敗しても確定は成立＝警告を返し、/royalty/events から手動記帳で回復できる。
      let royaltyEventRecorded = false;
      let royaltyEventWarning: string | undefined;
      if (royaltyEvents?.enabled && input.templateType === "royalty_statement") {
        const eventInput = royaltyEventInputFromStatement(input.formData);
        if (eventInput) {
          try {
            const fee = calculateFee(eventInput.terms, eventInput.adjustments, eventInput.taxRatePct);
            await royaltyEvents.repository.appendRoyaltyCalcEvent({
              conditionLineId: eventInput.conditionLineId,
              documentId: document.id,
              period: eventInput.period,
              backlogIssueKey: input.issueKey,
              amountExTax: fee.actual_ex_tax,
              mgConsumedThisTime: 0,
              agConsumedThisTime: fee.ag_offset_this_time
            });
            royaltyEventRecorded = true;
          } catch (error) {
            royaltyEventWarning =
              `消化イベントの自動記帳に失敗しました（実績入力から手動記帳できます）: ` +
              String((error as Error)?.message ?? error).slice(0, 200);
          }
        }
      }

      response.status(201).json({
        document,
        integrations: {
          pdf: "pending",
          drive: "disabled",
          backlog: "disabled",
          conditions: conditionSyncResult ? "synced" : ledgerLinked ? "ledger" : conditionSyncWarning ? "warning" : "none",
          royaltyEvent: royaltyEventRecorded ? "recorded" : royaltyEventWarning ? "warning" : "none"
        },
        ...(conditionSyncResult ? { conditionSync: conditionSyncResult } : {}),
        ...(ledgerLinked ? { conditionLedger: ledgerLinked } : {}),
        ...(conditionSyncWarning ? { conditionSyncWarning } : {}),
        ...(royaltyEventWarning ? { royaltyEventWarning } : {})
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
