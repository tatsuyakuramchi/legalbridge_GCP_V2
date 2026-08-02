import { Router } from "express";
import { z } from "zod";
import { contractOutboundConditionSchema } from "./intake.js";
import {
  ContractOutboundReferenceError,
  type ContractOutboundRepository
} from "./intake-outbound-repository.js";

const pathSchema = z.object({
  documentId: z.coerce.number().int().positive()
});
const appendSchema = z.object({
  conditions: z.array(contractOutboundConditionSchema)
    .min(1, "アウト条件を1件以上指定してください").max(100)
});

export function validateContractOutbound(input: unknown) {
  const result = appendSchema.safeParse(input);
  if (!result.success) {
    return {
      ok: false as const,
      errors: result.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message
      }))
    };
  }
  return { ok: true as const, conditions: result.data.conditions };
}

export function createContractOutboundRouter(
  outbound: ContractOutboundRepository | undefined,
  writeEnabled = false
) {
  const router = Router();

  router.post("/contract-intakes/outbound-conditions/validate",
    (request, response) => {
      const result = validateContractOutbound(request.body);
      response.status(result.ok ? 200 : 400).json(result);
    });

  router.get("/contract-intakes/:documentId/outbound-conditions",
    async (request, response, next) => {
      try {
        if (!outbound) {
          return response.status(503).json({
            error: "contract outbound registry is unavailable",
            code: "CONTRACT_OUTBOUND_UNAVAILABLE"
          });
        }
        if (response.locals.currentUser?.role !== "admin") {
          return response.status(403).json({
            error: "administrator approval is required",
            code: "CONTRACT_INTAKE_ADMIN_REQUIRED"
          });
        }
        const { documentId } = pathSchema.parse(request.params);
        const items = await outbound.list(documentId);
        return response.status(200).json({ items });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return response.status(400).json({
            error: "invalid request",
            issues: error.issues
          });
        }
        next(error);
      }
    });

  router.post("/contract-intakes/:documentId/outbound-conditions",
    async (request, response, next) => {
      try {
        if (!writeEnabled || !outbound) {
          return response.status(503).json({
            error: "contract outbound storage is unavailable",
            code: "CONTRACT_OUTBOUND_UNAVAILABLE"
          });
        }
        if (response.locals.currentUser?.role !== "admin") {
          return response.status(403).json({
            error: "administrator approval is required",
            code: "CONTRACT_INTAKE_ADMIN_REQUIRED"
          });
        }
        const { documentId } = pathSchema.parse(request.params);
        const { conditions } = appendSchema.parse(request.body);
        const appended = await outbound.append(
          documentId,
          conditions,
          response.locals.currentUser.email
        );
        return response.status(201).json({
          documentId,
          appended,
          integrations: {
            backlog: "disabled",
            slack: "disabled",
            drive: "disabled"
          }
        });
      } catch (error) {
        if (error instanceof ContractOutboundReferenceError) {
          const status = error.code === "CONTRACT_INTAKE_DOCUMENT_NOT_FOUND"
            ? 404
            : error.code === "OUTBOUND_MATERIAL_OUT_OF_RANGE"
              ? 422
              : error.code === "OUTBOUND_VENDOR_NOT_FOUND"
                ? 404
                : 409;
          return response.status(status).json({
            error: error.message,
            code: error.code
          });
        }
        if (error instanceof z.ZodError) {
          return response.status(400).json({
            error: "invalid request",
            issues: error.issues
          });
        }
        next(error);
      }
    });

  return router;
}
