import { Router } from "express";
import { z } from "zod";
import type { DraftRepository } from "../documents/draft-repository.js";
import type { TemplateRepository } from "../documents/template-repository.js";
import {
  SettlementError,
  type LicenseSettlementRepository,
  type SettlementPreviewInput
} from "./repository.js";

const triggerSchema = z.enum(["manufacturing", "sale", "sublicense_receipt"]);
const previewSchema = z.object({
  conditionLineId: z.coerce.number().int().positive(),
  trigger: triggerSchema,
  occurredAt: z.string().min(1),
  productName: z.string().trim().max(300).optional(),
  edition: z.string().trim().max(100).optional(),
  quantity: z.coerce.number().nonnegative().optional(),
  sampleQuantity: z.coerce.number().nonnegative().optional(),
  unitBase: z.coerce.number().nonnegative().optional(),
  grossAmount: z.coerce.number().nonnegative().optional(),
  deductions: z.coerce.number().nonnegative().optional(),
  useNetBasis: z.boolean().optional().default(false)
});

const draftSchema = previewSchema.extend({
  issueKey: z.string().trim().min(1).max(100)
});

export function createLicenseSettlementRouter(
  settlements: LicenseSettlementRepository,
  templates: TemplateRepository,
  drafts: DraftRepository,
  draftWriteEnabled = false
) {
  const router = Router();

  router.get("/license-settlements/conditions", async (request, response, next) => {
    try {
      const query = String(request.query.q ?? "").slice(0, 100);
      const limit = Number.parseInt(String(request.query.limit ?? "200"), 10) || 200;
      return response.json({ conditions: await settlements.listConditions(query, limit) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/license-settlements/preview", async (request, response, next) => {
    try {
      const input = previewSchema.parse(request.body) as SettlementPreviewInput;
      return response.json({ preview: await settlements.preview(input) });
    } catch (error) {
      if (error instanceof SettlementError) {
        return response.status(404).json({ error: error.message, code: error.code });
      }
      if (error instanceof z.ZodError) {
        return response.status(400).json({ error: "invalid settlement input", issues: error.issues });
      }
      next(error);
    }
  });

  router.post("/license-settlements/draft", async (request, response, next) => {
    try {
      if (!draftWriteEnabled) {
        return response.status(503).json({
          error: "利用許諾計算書のドラフト保存は現在無効です",
          code: "SETTLEMENT_DRAFT_WRITE_UNAVAILABLE"
        });
      }
      const input = draftSchema.parse(request.body);
      const preview = await settlements.preview(input as SettlementPreviewInput);
      const schema = await templates.findCurrent("royalty_statement");
      if (!schema) {
        return response.status(503).json({
          error: "royalty_statement template is not available",
          code: "ROYALTY_TEMPLATE_UNAVAILABLE"
        });
      }

      const c = preview.settlementCondition;
      const today = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit"
      }).format(new Date());
      const eventDate = String(input.occurredAt).slice(0, 10);
      const basisNote = [
        `トリガー: ${triggerLabel(preview.trigger)}`,
        `発生日: ${eventDate}`,
        `算定式: ${preview.formula}`,
        preview.deductions > 0 ? `控除: ${formatMoney(preview.deductions, preview.currency)}` : "",
        preview.sourceCondition.id !== preview.settlementCondition.id
          ? `OUT条件 #${preview.sourceCondition.id} → 根拠IN条件 #${preview.settlementCondition.id}`
          : `条件 #${preview.settlementCondition.id}`,
        ...preview.warnings
      ].filter(Boolean).join("\n");

      const formData = {
        documentDate: today,
        linked_contract_number: c.documentNumber ?? "",
        licensor: c.counterparty ?? "",
        licensor_t_number: input.issueKey,
        licensee: "株式会社アークライト",
        originalWork: c.workTitle ?? preview.sourceCondition.workTitle ?? "",
        productName: preview.productName,
        edition: preview.edition,
        completionDate: eventDate,
        quantity: preview.quantity,
        sampleQuantity: preview.sampleQuantity,
        billableQuantity: preview.billableQuantity,
        msrpStr: preview.unitBase ? formatMoney(preview.unitBase, preview.currency) : "",
        calcType: preview.trigger === "sublicense_receipt" ? "sublicense" : preview.trigger,
        royaltyRatePct: preview.ratePct ?? "",
        grossRoyaltyStr: formatMoney(preview.grossRoyalty, preview.currency),
        mgAmount: c.mgAmount ?? 0,
        agAmount: c.agAmount ?? 0,
        actualRoyalty: preview.actualRoyalty,
        actualRoyaltyStr: formatMoney(preview.actualRoyalty, preview.currency),
        currency: preview.currency,
        paymentConditionSummary: c.paymentTerms ?? "",
        notes: basisNote,
        lines: [{
          productName: preview.productName,
          sales_amount: preview.basisAmount,
          rate_pct: preview.ratePct ?? "",
          royalty_amount: preview.actualRoyalty,
          basisNote
        }],
        source_condition_line_id: c.id,
        source_out_condition_line_id: preview.sourceCondition.id,
        settlement_trigger: preview.trigger,
        settlement_occurred_at: input.occurredAt,
        settlement_basis_amount: preview.basisAmount,
        settlement_gross_event_amount: preview.grossEventAmount,
        settlement_deductions: preview.deductions,
        settlement_use_net_basis: input.useNetBasis,
        settlement_warnings: preview.warnings
      };

      const actor = response.locals.currentUser;
      const saved = await drafts.save({
        issueKey: input.issueKey,
        templateType: "royalty_statement",
        formData,
        updatedBy: actor?.source === "iap" ? actor.email : null
      });
      return response.status(201).json({ draft: saved, preview });
    } catch (error) {
      if (error instanceof SettlementError) {
        return response.status(404).json({ error: error.message, code: error.code });
      }
      if (error instanceof z.ZodError) {
        return response.status(400).json({ error: "invalid settlement input", issues: error.issues });
      }
      next(error);
    }
  });

  return router;
}

function triggerLabel(value: "manufacturing" | "sale" | "sublicense_receipt") {
  if (value === "manufacturing") return "製造";
  if (value === "sale") return "販売";
  return "サブライセンス料入金";
}
function formatMoney(value: number, currency: string) {
  return `${currency} ${new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 2 }).format(value)}`;
}
