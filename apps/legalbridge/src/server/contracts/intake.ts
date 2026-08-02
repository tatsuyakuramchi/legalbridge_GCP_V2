import { Router } from "express";
import { z } from "zod";

const optionalText = (max = 500) =>
  z.string().trim().max(max).optional().transform((value) => value || undefined);
const optionalNonnegative = z.number().nonnegative().optional();

const workReferenceSchema = z.object({
  existingWorkId: z.number().int().positive().optional(),
  title: optionalText(300),
  titleKana: optionalText(300),
  workType: z.enum(["board_game", "trpg_book", "other"]).optional(),
  status: z.enum(["planning", "in_production", "released"]).optional(),
  rightsHolderVendorId: z.number().int().positive().optional(),
  creatorName: optionalText(300),
  publisherName: optionalText(300),
  remarks: optionalText(2000)
}).superRefine((value, context) => {
  const referenceCount = Number(value.existingWorkId !== undefined) + Number(Boolean(value.title));
  if (referenceCount !== 1) {
    context.addIssue({
      code: "custom",
      path: ["existingWorkId"],
      message: "既存作品IDまたは新規作品名のいずれか一方を指定してください"
    });
  }
});

const materialSchema = z.object({
  existingMaterialId: z.number().int().positive().optional(),
  materialName: optionalText(300),
  materialType: z.enum([
    "game_design",
    "illustration",
    "scenario",
    "manuscript",
    "other"
  ]).optional(),
  materialRole: z.enum(["core_logic", "sub_component"]).optional(),
  acquisitionType: z.enum([
    "license",
    "buyout_commission",
    "in_house"
  ]).optional(),
  rightsType: z.enum(["owned", "license"]).optional(),
  rightsHolderVendorId: z.number().int().positive().optional(),
  rightsHolderLabel: optionalText(300),
  territory: optionalText(500),
  language: optionalText(500),
  isDefault: z.boolean().optional().default(false),
  isRoyaltyBearing: z.boolean().optional().default(false),
  remarks: optionalText(2000)
}).superRefine((value, context) => {
  const referenceCount =
    Number(value.existingMaterialId !== undefined) + Number(Boolean(value.materialName));
  if (referenceCount !== 1) {
    context.addIssue({
      code: "custom",
      path: ["existingMaterialId"],
      message: "既存素材IDまたは新規素材名のいずれか一方を指定してください"
    });
  }
  if (!value.existingMaterialId) {
    for (const field of ["materialType", "materialRole", "acquisitionType"] as const) {
      if (!value[field]) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: "新規素材では必須です"
        });
      }
    }
  }
});

const conditionBaseSchema = z.object({
  conditionName: z.string().trim().min(1, "条件名を入力してください").max(300),
  transactionKind: z.enum(["license", "product", "service"]),
  materialIndex: z.number().int().nonnegative().optional(),
  territory: z.string().trim().min(1, "許諾地域を入力してください").max(500),
  languages: z.array(z.string().trim().min(1).max(100))
    .min(1, "許諾言語を入力してください").max(30),
  exclusivity: z.enum(["exclusive", "non_exclusive", "sole"]).optional(),
  sublicenseAllowed: z.boolean().optional().default(false),
  rightsAttribution: z.enum([
    "transfer",
    "retained_license",
    "license_only",
    "joint"
  ]).optional(),
  termStart: z.iso.date().optional(),
  termEnd: z.iso.date().optional(),
  currency: z.string().trim().length(3)
    .transform((value) => value.toUpperCase()).default("JPY"),
  paymentScheme: z.enum([
    "lump_sum",
    "per_unit",
    "installment",
    "subscription",
    "royalty"
  ]),
  ratePct: optionalNonnegative,
  amountExTax: optionalNonnegative,
  mgAmount: optionalNonnegative,
  advanceAmount: optionalNonnegative,
  reportingCycle: optionalText(200),
  paymentTerms: optionalText(1000),
  royaltyBase: optionalText(1000),
  deductibleCosts: optionalText(1000),
  withholdingTaxTreatment: optionalText(1000),
  minimumQuantity: z.number().int().nonnegative().optional(),
  sellOffMonths: z.number().int().nonnegative().optional(),
  incoterms: optionalText(100),
  notes: optionalText(4000)
}).superRefine((value, context) => {
  if (value.termStart && value.termEnd && value.termStart > value.termEnd) {
    context.addIssue({
      code: "custom",
      path: ["termEnd"],
      message: "終了日は開始日以後にしてください"
    });
  }
  if (value.ratePct !== undefined && value.ratePct > 100) {
    context.addIssue({
      code: "custom",
      path: ["ratePct"],
      message: "料率は100%以下にしてください"
    });
  }
  if (value.paymentScheme === "royalty" && value.ratePct === undefined) {
    context.addIssue({
      code: "custom",
      path: ["ratePct"],
      message: "ロイヤリティ方式では料率が必要です"
    });
  }
  if (value.paymentScheme !== "royalty") {
    if (value.amountExTax === undefined) {
      context.addIssue({
        code: "custom",
        path: ["amountExTax"],
        message: "ロイヤリティ以外の方式では税抜金額が必要です"
      });
    }
    for (const field of ["ratePct", "mgAmount", "advanceAmount"] as const) {
      if (value[field] !== undefined) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: "ロイヤリティ方式以外では使用できません"
        });
      }
    }
  }
});

const inboundConditionSchema = conditionBaseSchema.safeExtend({
  counterpartyVendorId: z.number().int().positive().optional()
});

const outboundConditionSchema = conditionBaseSchema.safeExtend({
  counterpartyVendorId: z.number().int().positive(),
  parentInboundIndex: z.number().int().nonnegative()
});

const contractSchema = z.object({
  documentNumber: z.string().trim().min(1, "締結済契約書番号を入力してください").max(100),
  contractTitle: z.string().trim().min(1, "契約名を入力してください").max(500),
  primaryVendorId: z.number().int().positive(),
  contractType: z.string().trim().min(1).max(100).default("license_basic"),
  recordType: z.literal("license_condition").default("license_condition"),
  contractLevel: z.literal("individual").default("individual"),
  contractCategory: z.literal("license").default("license"),
  contractStatus: z.literal("executed").default("executed"),
  lifecycleStage: z.literal("executed").default("executed"),
  executedAt: z.iso.date(),
  effectiveDate: z.iso.date().optional(),
  expirationDate: z.iso.date().optional(),
  autoRenewal: z.boolean().optional().default(false),
  renewalNoticeMonths: z.number().int().nonnegative().optional(),
  scope: optionalText(4000),
  documentUrl: z.url().optional(),
  sourceSystem: z.string().trim().max(100).default("legalbridge_v2")
}).superRefine((value, context) => {
  if (value.effectiveDate && value.expirationDate &&
      value.effectiveDate > value.expirationDate) {
    context.addIssue({
      code: "custom",
      path: ["expirationDate"],
      message: "契約終了日は効力発生日以後にしてください"
    });
  }
});

export const contractIntakeSchema = z.object({
  requestId: z.uuid().optional(),
  sourceWork: workReferenceSchema,
  ownWork: workReferenceSchema,
  materials: z.array(materialSchema).min(1, "素材を1件以上指定してください").max(100),
  contract: contractSchema,
  inboundConditions: z.array(inboundConditionSchema)
    .min(1, "イン条件を1件以上指定してください").max(100),
  outboundConditions: z.array(outboundConditionSchema).max(100).optional().default([])
}).superRefine((value, context) => {
  value.inboundConditions.forEach((condition, index) => {
    if (condition.materialIndex !== undefined &&
        condition.materialIndex >= value.materials.length) {
      context.addIssue({
        code: "custom",
        path: ["inboundConditions", index, "materialIndex"],
        message: "存在しない素材番号です"
      });
    }
  });
  value.outboundConditions.forEach((condition, index) => {
    if (condition.materialIndex !== undefined &&
        condition.materialIndex >= value.materials.length) {
      context.addIssue({
        code: "custom",
        path: ["outboundConditions", index, "materialIndex"],
        message: "存在しない素材番号です"
      });
    }
    if (condition.parentInboundIndex >= value.inboundConditions.length) {
      context.addIssue({
        code: "custom",
        path: ["outboundConditions", index, "parentInboundIndex"],
        message: "存在しないイン条件番号です"
      });
    }
  });
});

export type ContractIntakeInput = z.input<typeof contractIntakeSchema>;
export type ValidatedContractIntake = z.output<typeof contractIntakeSchema>;

export function validateContractIntake(input: unknown) {
  const result = contractIntakeSchema.safeParse(input);
  if (!result.success) {
    return {
      ok: false as const,
      errors: result.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message
      }))
    };
  }

  const intake = result.data;
  return {
    ok: true as const,
    intake,
    plan: {
      mode: "preview" as const,
      sourceWork: intake.sourceWork.existingWorkId ? "reuse" as const : "create" as const,
      ownWork: intake.ownWork.existingWorkId ? "reuse" as const : "create" as const,
      materialsToReuse: intake.materials.filter((item) => item.existingMaterialId).length,
      materialsToCreate: intake.materials.filter((item) => !item.existingMaterialId).length,
      contractsToCreate: 1,
      documentsToCreate: 1,
      inboundConditionsToCreate: intake.inboundConditions.length,
      outboundConditionsToCreate: intake.outboundConditions.length,
      integrations: {
        backlog: "disabled" as const,
        slack: "disabled" as const,
        drive: "disabled" as const
      }
    }
  };
}

export function createContractIntakeRouter() {
  const router = Router();

  router.post("/contract-intakes/validate", (request, response) => {
    const result = validateContractIntake(request.body);
    response.status(result.ok ? 200 : 400).json(result);
  });

  return router;
}
