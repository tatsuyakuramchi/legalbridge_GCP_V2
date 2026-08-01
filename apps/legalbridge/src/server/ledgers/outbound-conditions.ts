import { Router } from "express";
import { z } from "zod";
import {
  OutboundConditionConflictError,
  OutboundConditionReferenceError,
  type OutboundConditionRepository
} from "./outbound-condition-repository.js";

const optionalText = z.string().trim().max(500).optional().default("");
const optionalNumber = z.number().nonnegative().optional();

export const outboundConditionSchema = z.object({
  workId: z.string().trim().min(1, "作品を選択してください").max(100),
  workLabel: z.string().trim().min(1).max(300),
  counterpartyId: z.string().trim().min(1, "相手方を選択してください").max(100),
  counterpartyLabel: z.string().trim().min(1).max(300),
  transactionKind: z.enum(["license", "product"]),
  conditionName: z.string().trim().min(1, "条件名を入力してください").max(300),
  documentNumber: optionalText,
  territory: z.string().trim().min(1, "対象地域を入力してください").max(300),
  languages: z.array(z.string().trim().min(1).max(100)).min(1, "対象言語を入力してください").max(30),
  exclusivity: z.enum(["exclusive", "non_exclusive", "sole"]),
  sublicenseAllowed: z.boolean().default(false),
  termStart: z.iso.date().optional(),
  termEnd: z.iso.date().optional(),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()),
  paymentScheme: z.enum(["royalty", "per_unit", "lump_sum"]),
  ratePct: optionalNumber,
  amountExTax: optionalNumber,
  mgAmount: optionalNumber,
  advanceAmount: optionalNumber,
  reportingCycle: optionalText,
  paymentTerms: optionalText,
  royaltyBase: optionalText,
  incoterms: optionalText,
  minimumQuantity: z.number().int().nonnegative().optional(),
  sellOffPeriod: optionalText,
  withholdingTaxTreatment: optionalText,
  notes: z.string().trim().max(4000).optional().default("")
}).superRefine((value, context) => {
  if (value.termStart && value.termEnd && value.termStart > value.termEnd) {
    context.addIssue({ code: "custom", path: ["termEnd"], message: "終了日は開始日以後にしてください" });
  }
  if (value.transactionKind === "license" && value.paymentScheme !== "royalty") {
    context.addIssue({ code: "custom", path: ["paymentScheme"], message: "ライセンスアウトはロイヤリティ方式を選択してください" });
  }
  if (value.paymentScheme === "royalty" && value.ratePct === undefined) {
    context.addIssue({ code: "custom", path: ["ratePct"], message: "ロイヤリティ率を入力してください" });
  }
  if (value.ratePct !== undefined && value.ratePct > 100) {
    context.addIssue({ code: "custom", path: ["ratePct"], message: "料率は100%以下にしてください" });
  }
  if (value.transactionKind === "product" && value.paymentScheme === "royalty") {
    context.addIssue({ code: "custom", path: ["paymentScheme"], message: "プロダクトアウトは単価または一括金額を選択してください" });
  }
  if (value.paymentScheme !== "royalty" && value.amountExTax === undefined) {
    context.addIssue({ code: "custom", path: ["amountExTax"], message: "税抜金額を入力してください" });
  }
});

export type OutboundConditionInput = z.input<typeof outboundConditionSchema>;

export function validateOutboundCondition(input: unknown) {
  const result = outboundConditionSchema.safeParse(input);
  if (!result.success) {
    return {
      ok: false as const,
      errors: result.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message
      }))
    };
  }
  return {
    ok: true as const,
    condition: {
      ...result.data,
      direction: "receivable" as const
    }
  };
}

export function createOutboundConditionRouter(
  repository?: OutboundConditionRepository,
  writeEnabled = false
) {
  const router = Router();

  router.post("/outbound-conditions/validate", (request, response) => {
    const result = validateOutboundCondition(request.body);
    response.status(result.ok ? 200 : 400).json(result);
  });

  router.post("/outbound-conditions", async (request, response, next) => {
    try {
      if (!writeEnabled || !repository) {
        return response.status(503).json({
          error: "outbound condition storage is unavailable",
          code: "OUTBOUND_CONDITION_STORAGE_UNAVAILABLE"
        });
      }
      if (response.locals.currentUser?.role !== "admin") {
        return response.status(403).json({
          error: "administrator approval is required",
          code: "OUTBOUND_CONDITION_ADMIN_REQUIRED"
        });
      }
      const condition = outboundConditionSchema.parse(request.body);
      if (!condition.documentNumber) {
        return response.status(400).json({
          error: "document number is required",
          code: "OUTBOUND_DOCUMENT_REQUIRED"
        });
      }
      const saved = await repository.save(condition);
      return response.status(201).json({
        condition: saved,
        integrations: { backlog: "disabled", slack: "disabled", drive: "disabled" }
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return response.status(400).json({ error: "invalid request", issues: error.issues });
      }
      if (error instanceof OutboundConditionReferenceError) {
        return response.status(404).json({
          error: error.message,
          code: "OUTBOUND_REFERENCE_NOT_FOUND"
        });
      }
      if (error instanceof OutboundConditionConflictError) {
        return response.status(409).json({
          error: error.message,
          code: "OUTBOUND_CONDITION_CONFLICT"
        });
      }
      next(error);
    }
  });

  return router;
}
