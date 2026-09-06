import { Router } from "express";
import { z } from "zod";
import { MatterWriteError } from "./write-repository.js";
import {
  DELIVERY_STATUSES, PAYMENT_STATUSES, type MatterDeliveryPaymentRepository
} from "./delivery-payment-repository.js";

// 案件画面の業務委託フロー ③納品・報告 ⑤支払 の登録 API（2026-09-06）。
//   POST  /matters/:id/deliveries            納品実績を登録（delivery_events）
//   PATCH /matters/:id/deliveries/:deliveryId 状態（検収済など）・検収期限を更新
//   POST  /matters/:id/payments              支払を登録（payments・scope 'payments'・grant 016）
//   PATCH /matters/:id/payments/:paymentId   状態（支払済）・支払日を更新
// 納品は案件編集（scope 'matters'）、支払は支払台帳（scope 'payments'）の capability で守る。

const matterPath = z.object({ id: z.coerce.number().int().positive() });
const deliveryPath = matterPath.extend({ deliveryId: z.coerce.number().int().positive() });
const paymentPath = matterPath.extend({ paymentId: z.coerce.number().int().positive() });
const dateString = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "日付は YYYY-MM-DD で入力してください");
const optionalDate = dateString.nullable().optional();
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional()
  .transform((v) => (v && v.length ? v : null));

export const deliveryCreateSchema = z.object({
  backlogIssueKey: optionalText(50),
  deliveredOn: optionalDate,
  deliveredAmount: z.coerce.number().min(0).max(1e12).nullable().optional(),
  inspectionDeadline: optionalDate,
  status: z.enum(DELIVERY_STATUSES as [string, ...string[]]).optional(),
  documentNumber: optionalText(120),
  note: optionalText(2000)
});
export const deliveryPatchSchema = z.object({
  status: z.enum(DELIVERY_STATUSES as [string, ...string[]]).optional(),
  inspectionDeadline: optionalDate
});
export const paymentCreateSchema = z.object({
  backlogIssueKey: optionalText(50),
  amountExTax: z.coerce.number().min(0).max(1e12),
  totalAmount: z.coerce.number().min(0).max(1e12).nullable().optional(),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/).optional(),
  dueDate: optionalDate,
  paidDate: optionalDate,
  status: z.enum(PAYMENT_STATUSES as [string, ...string[]]).optional(),
  sourceDocumentNumber: optionalText(120),
  counterpartyVendorId: z.coerce.number().int().positive().nullable().optional(),
  paymentKind: z.string().trim().max(50).optional(),
  note: optionalText(2000)
});
export const paymentPatchSchema = z.object({
  status: z.enum(PAYMENT_STATUSES as [string, ...string[]]).optional(),
  paidDate: optionalDate,
  dueDate: optionalDate
});

function editorAllowed(role: string | undefined) { return role === "admin" || role === "legal"; }
function statusFor(code: string) {
  if (code === "MATTER_NOT_FOUND" || code === "MATTER_TASK_NOT_FOUND") return 404;
  if (code === "MATTER_REFERENCE_INVALID" || code === "MATTER_ISSUE_REQUIRED" || code === "MATTER_CHECK_FAILED") return 422;
  if (code.endsWith("_SCHEMA_UNSUPPORTED")) return 422;
  if (code.endsWith("_GRANT_MISSING")) return 503;
  return 400;
}

export function createMatterDeliveryPaymentRouter(
  repository: MatterDeliveryPaymentRepository | undefined,
  options: { deliveryWriteEnabled?: boolean; paymentWriteEnabled?: boolean } = {}
) {
  const router = Router();
  const handle = (error: unknown, response: import("express").Response, next: import("express").NextFunction) => {
    if (error instanceof z.ZodError) {
      return response.status(400).json({ error: "入力内容を確認してください", code: "INVALID_INPUT", issues: error.issues });
    }
    if (error instanceof MatterWriteError) {
      return response.status(statusFor(error.code)).json({ error: error.message, code: error.code });
    }
    return next(error);
  };
  const guard = (
    response: import("express").Response, enabled: boolean | undefined, unavailableCode: string
  ) => {
    if (!enabled || !repository) {
      response.status(503).json({ error: "この登録は未有効化です", code: unavailableCode });
      return false;
    }
    if (!editorAllowed(response.locals.currentUser?.role)) {
      response.status(403).json({ error: "法務または管理者のみが登録できます", code: "MATTER_EDIT_FORBIDDEN" });
      return false;
    }
    return true;
  };

  router.post("/matters/:id/deliveries", async (request, response, next) => {
    try {
      if (!guard(response, options.deliveryWriteEnabled, "DELIVERY_WRITE_UNAVAILABLE")) return;
      const { id } = matterPath.parse(request.params);
      const input = deliveryCreateSchema.parse(request.body ?? {});
      const created = await repository!.createDelivery(id, input as never, response.locals.currentUser!.email);
      return response.status(201).json({ delivery: created });
    } catch (error) { return handle(error, response, next); }
  });

  router.patch("/matters/:id/deliveries/:deliveryId", async (request, response, next) => {
    try {
      if (!guard(response, options.deliveryWriteEnabled, "DELIVERY_WRITE_UNAVAILABLE")) return;
      const { id, deliveryId } = deliveryPath.parse(request.params);
      const patch = deliveryPatchSchema.parse(request.body ?? {});
      const updated = await repository!.updateDelivery(id, deliveryId, patch as never);
      return response.status(200).json({ delivery: updated });
    } catch (error) { return handle(error, response, next); }
  });

  router.post("/matters/:id/payments", async (request, response, next) => {
    try {
      if (!guard(response, options.paymentWriteEnabled, "PAYMENT_WRITE_UNAVAILABLE")) return;
      const { id } = matterPath.parse(request.params);
      const input = paymentCreateSchema.parse(request.body ?? {});
      const created = await repository!.createPayment(id, input as never, response.locals.currentUser!.email);
      return response.status(201).json({ payment: created });
    } catch (error) { return handle(error, response, next); }
  });

  router.patch("/matters/:id/payments/:paymentId", async (request, response, next) => {
    try {
      if (!guard(response, options.paymentWriteEnabled, "PAYMENT_WRITE_UNAVAILABLE")) return;
      const { id, paymentId } = paymentPath.parse(request.params);
      const patch = paymentPatchSchema.parse(request.body ?? {});
      const updated = await repository!.updatePayment(id, paymentId, patch as never);
      return response.status(200).json({ payment: updated });
    } catch (error) { return handle(error, response, next); }
  });

  return router;
}
