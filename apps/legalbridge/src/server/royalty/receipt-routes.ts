import { Router } from "express";
import { z } from "zod";
import { ReceiptReferenceError, type ReceiptRepository } from "./receipt-repository.js";

// 再許諾料の受領記録（guarded-write）。既定OFF・admin/legal限定・確認トークン必須・
// DELETEなし。受領再許諾料はサーバが再計算する（フロント金額は使わない）。
// payments 台帳同期・分配は別スライス。

const CONFIRMATION = "COMMIT_PRODUCTION_RECEIPT";

const bodyFields = {
  period: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  periodDate: z.iso.date().optional(),
  reportedSales: z.number().optional(),
  reportedQuantity: z.number().optional(),
  receivedAmount: z.number().optional(),
  receivedDate: z.iso.date().optional(),
  note: z.string().trim().max(4000).optional(),
  calcType: z.string().trim().max(30).optional(),
  distributionBase: z.number().optional(),
  distributionQty: z.number().optional()
};

const createSchema = z.object({
  confirmation: z.string(),
  conditionLineId: z.number().int().positive(),
  ...bodyFields
});

const updateSchema = z.object({
  confirmation: z.string(),
  ...bodyFields
});

export function createReceiptRouter(
  repository?: ReceiptRepository,
  writeEnabled = false
) {
  const router = Router();

  function guard(request: import("express").Request, response: import("express").Response): boolean {
    if (!writeEnabled || !repository) {
      response.status(503).json({ error: "receipt storage is unavailable", code: "RECEIPT_STORAGE_UNAVAILABLE" });
      return false;
    }
    const role = response.locals.currentUser?.role;
    if (role !== "admin" && role !== "legal") {
      response.status(403).json({ error: "administrator or legal approval is required", code: "RECEIPT_ROLE_REQUIRED" });
      return false;
    }
    if (request.body?.confirmation !== CONFIRMATION) {
      response.status(400).json({ error: "explicit production confirmation is required", code: "RECEIPT_CONFIRMATION_REQUIRED" });
      return false;
    }
    return true;
  }

  router.post("/condition-receipts", async (request, response, next) => {
    try {
      if (!guard(request, response)) return;
      const input = createSchema.parse(request.body);
      const { confirmation: _c, conditionLineId, ...fields } = input;
      const saved = await repository!.create(conditionLineId, fields);
      return response.status(201).json({ receipt: saved });
    } catch (error) {
      return handleError(error, response, next);
    }
  });

  router.put("/condition-receipts/:id", async (request, response, next) => {
    try {
      if (!guard(request, response)) return;
      const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
      const input = updateSchema.parse(request.body);
      const { confirmation: _c, ...fields } = input;
      const saved = await repository!.update(id, fields);
      return response.status(200).json({ receipt: saved });
    } catch (error) {
      return handleError(error, response, next);
    }
  });

  return router;
}

function handleError(error: unknown, response: import("express").Response, next: import("express").NextFunction) {
  if (error instanceof z.ZodError) {
    return response.status(400).json({ error: "invalid request", issues: error.issues });
  }
  if (error instanceof ReceiptReferenceError) {
    return response.status(404).json({ error: error.message, code: "RECEIPT_REFERENCE_NOT_FOUND" });
  }
  next(error);
}
