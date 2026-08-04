import { Router } from "express";
import { z } from "zod";
import { calculateFee } from "./calc.js";
import { computeRoyaltyPayment, resolveWithholdingEnabled } from "./tax.js";

// 計算専用（read-only・DB非依存・GRANT不要）のロイヤリティ試算。
// V1 の /api/royalty-calculations/preview 相当の「確定前ライブ試算」を、
// V2 の純関数エンジン（calc / tax）で構成する。書込みは一切行わない。

export const feeTermsSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("fixed"), unit_price: z.number(), quantity: z.number() }),
  z.object({
    type: z.literal("subscription"),
    period_amount: z.number(),
    period_count: z.number(),
    period_unit: z.enum(["monthly", "yearly"]).optional(),
    initial_fee: z.number().optional()
  }),
  z.object({ type: z.literal("performance"), base_price: z.number(), rate_pct: z.number(), quantity: z.number() }),
  z.object({ type: z.literal("revenue"), base_amount: z.number(), rate_pct: z.number() })
]);

export const adjustmentsSchema = z.object({
  acceptance_ratio: z.number().optional(),
  sample_quantity: z.number().optional(),
  mg_amount: z.number().optional(),
  ag_amount: z.number().optional(),
  ag_consumed_before: z.number().optional()
});

const previewSchema = z.object({
  terms: feeTermsSchema,
  adjustments: adjustmentsSchema.optional(),
  taxRatePct: z.number().optional().default(10),
  withholding: z
    .object({
      vendorWithholdingEnabled: z.boolean().optional(),
      entityType: z.string().optional(),
      formOverride: z.boolean().optional()
    })
    .optional(),
  reimbursementIncTax: z.number().optional().default(0)
});

export function createRoyaltyRouter() {
  const router = Router();

  router.post("/royalty/preview", (request, response) => {
    try {
      const input = previewSchema.parse(request.body);
      const fee = calculateFee(input.terms, input.adjustments ?? {}, input.taxRatePct);
      const withholdingEnabled = resolveWithholdingEnabled(input.withholding ?? {});
      // 源泉・振込額は fee.actual_ex_tax を税抜小計として算出する。
      const payment = computeRoyaltyPayment({
        subtotalExTax: fee.actual_ex_tax,
        taxRatePct: input.taxRatePct,
        withholdingEnabled,
        reimbursementIncTax: input.reimbursementIncTax
      });
      return response.status(200).json({ fee, withholdingEnabled, payment });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return response.status(400).json({ error: "invalid request", issues: error.issues });
      }
      return response.status(500).json({ error: "royalty preview failed" });
    }
  });

  return router;
}
