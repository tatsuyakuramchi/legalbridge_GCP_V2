import { Router } from "express";
import { z } from "zod";
import { calculateFee } from "./calc.js";
import { feeTermsSchema, adjustmentsSchema } from "./routes.js";
import {
  RoyaltyEventConflictError,
  RoyaltyEventReferenceError,
  type RoyaltyEventRepository
} from "./event-repository.js";

// ロイヤリティ消化イベントの記録（guarded-write）。既定OFF・admin/legal限定・
// 確認トークン必須・DELETEなし。金額はサーバが calculateFee で再計算する
// （フロント値は信用しない＝V1の preview 再実行防御パターン）。

const CONFIRMATION = "COMMIT_PRODUCTION_ROYALTY_EVENT";

const eventSchema = z.object({
  confirmation: z.string(),
  conditionLineId: z.number().int().positive(),
  documentId: z.number().int().positive(),
  period: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  backlogIssueKey: z.string().trim().max(50).optional(),
  terms: feeTermsSchema,
  adjustments: adjustmentsSchema.optional(),
  taxRatePct: z.number().optional().default(10)
});

export function createRoyaltyEventRouter(
  repository?: RoyaltyEventRepository,
  writeEnabled = false
) {
  const router = Router();

  router.post("/royalty/events", async (request, response, next) => {
    try {
      if (!writeEnabled || !repository) {
        return response.status(503).json({
          error: "royalty event storage is unavailable",
          code: "ROYALTY_EVENT_STORAGE_UNAVAILABLE"
        });
      }
      const role = response.locals.currentUser?.role;
      if (role !== "admin" && role !== "legal") {
        return response.status(403).json({
          error: "administrator or legal approval is required",
          code: "ROYALTY_EVENT_ROLE_REQUIRED"
        });
      }
      if (request.body?.confirmation !== CONFIRMATION) {
        return response.status(400).json({
          error: "explicit production confirmation is required",
          code: "ROYALTY_EVENT_CONFIRMATION_REQUIRED"
        });
      }

      const input = eventSchema.parse(request.body);
      // サーバ再計算：フロントが送る金額は使わず、terms/adjustments から算出する。
      const fee = calculateFee(input.terms, input.adjustments ?? {}, input.taxRatePct);
      const saved = await repository.appendRoyaltyCalcEvent({
        conditionLineId: input.conditionLineId,
        documentId: input.documentId,
        period: input.period ?? null,
        backlogIssueKey: input.backlogIssueKey ?? null,
        amountExTax: fee.actual_ex_tax,
        mgConsumedThisTime: 0,
        agConsumedThisTime: fee.ag_offset_this_time
      });

      return response.status(201).json({ event: saved, fee });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return response.status(400).json({ error: "invalid request", issues: error.issues });
      }
      if (error instanceof RoyaltyEventReferenceError) {
        return response.status(404).json({ error: error.message, code: "ROYALTY_EVENT_REFERENCE_NOT_FOUND" });
      }
      if (error instanceof RoyaltyEventConflictError) {
        return response.status(409).json({ error: error.message, code: "ROYALTY_EVENT_CONFLICT" });
      }
      next(error);
    }
  });

  return router;
}
