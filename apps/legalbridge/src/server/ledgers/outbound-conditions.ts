import { Router } from "express";
import { z } from "zod";
import { displayScope, normalizeLanguageOption, normalizeRegionOption, type ScopeOption } from "../../rights-scope.js";
import {
  OutboundConditionConflictError,
  OutboundConditionReferenceError,
  OutboundConditionScopeError,
  type OutboundConditionRepository
} from "./outbound-condition-repository.js";

const optionalText = z.string().trim().max(500).optional().default("");
const optionalNumber = z.number().nonnegative().optional();
const scopeOptionSchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(120)
});
const languageInputSchema = z.union([scopeOptionSchema, z.string().trim().min(1).max(100)]);

export const outboundConditionSchema = z.object({
  workId: z.string().trim().min(1, "作品を選択してください").max(100),
  workLabel: z.string().trim().min(1).max(300),
  counterpartyId: z.string().trim().min(1, "相手方を選択してください").max(100),
  counterpartyLabel: z.string().trim().min(1).max(300),
  transactionKind: z.enum(["license", "product"]),
  conditionName: z.string().trim().min(1, "条件名を入力してください").max(300),
  sourceConditionId: z.number().int().positive().optional(),
  documentNumber: optionalText,
  territory: z.string().trim().max(300).optional().default(""),
  regions: z.array(scopeOptionSchema).max(250).optional().default([]),
  languages: z.array(languageInputSchema).min(1, "対象言語を入力してください").max(200),
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
  if (value.transactionKind === "license" && !value.sourceConditionId) {
    context.addIssue({ code: "custom", path: ["sourceConditionId"], message: "根拠IN条件を選択してください" });
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
  if (!value.regions.length && !value.territory.trim()) {
    context.addIssue({ code: "custom", path: ["regions"], message: "対象地域を選択してください" });
  }
  if (value.regions.some((item) => item.code.toUpperCase() === "WORLD") && value.regions.length > 1) {
    context.addIssue({ code: "custom", path: ["regions"], message: "WORLDと個別国は同時に選択できません" });
  }
  const allLanguageCount = value.languages.filter((item) =>
    typeof item !== "string" && item.code.toUpperCase() === "ALL"
  ).length;
  if (allLanguageCount && value.languages.length > 1) {
    context.addIssue({ code: "custom", path: ["languages"], message: "ALLと個別言語は同時に選択できません" });
  }
}).transform((value) => {
  const regions = value.regions.length
    ? dedupe(value.regions.map(normalizeRegionOption))
    : legacyRegionOptions(value.territory);
  const languages = dedupe(value.languages.map((item) =>
    typeof item === "string"
      ? legacyLanguageOption(item)
      : normalizeLanguageOption(item)
  ));
  return {
    ...value,
    regions,
    languages,
    territory: displayScope(regions)
  };
});

function dedupe(values: ScopeOption[]) {
  return [...new Map(values.filter((value) => value.code).map((value) => [value.code, value])).values()];
}

function legacyRegionOptions(value: string): ScopeOption[] {
  const text = value.trim();
  if (!text) return [];
  if (/全世界|world/i.test(text)) return [{ code: "WORLD", name: "全世界" }];
  return text.split(/[,、/]/).map((name) => name.trim()).filter(Boolean)
    .map((name, index) => ({ code: `LEGACY-R${index + 1}`, name }));
}

function legacyLanguageOption(value: string): ScopeOption {
  const text = value.trim();
  if (/全言語|all languages?/i.test(text)) return { code: "ALL", name: "全言語" };
  return { code: `LEGACY-L-${text.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 12) || "value"}`, name: text };
}

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
      if (error instanceof OutboundConditionScopeError) {
        return response.status(422).json({
          error: error.message,
          code: "OUTBOUND_SCOPE_EXCEEDS_SOURCE"
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
