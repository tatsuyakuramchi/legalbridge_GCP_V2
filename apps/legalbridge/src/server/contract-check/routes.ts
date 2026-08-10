import { Router } from "express";
import { z } from "zod";
import {
  CONTRACT_PURPOSES, findPurpose, buildMasterContractSummary, buildLicenseConditions,
  buildPublicationConditions, buildPurposeResult, buildSuggestedAction, notFoundResult,
  type AdditionalFlags
} from "./engine.js";
import type { ContractCheckRepository, VendorCandidate } from "./repository.js";

// 契約チェック API（Phase 16-2・読取専用）。V1 の /api/contract-check/* を移植。
// 認証済みユーザーなら誰でも利用可（依頼前の自己チェック用途のため requester も対象）。

const searchSchema = z.object({
  counterpartyName: z.string().trim().min(1, "Missing counterpartyName in request body"),
  purposeCode: z.string().trim().optional().default(""),
  vendorId: z.number().int().positive().optional(),
  additionalFlags: z.object({
    usesIp: z.boolean().optional(), includesSublicense: z.boolean().optional(),
    includesOverseas: z.boolean().optional(), includesEbook: z.boolean().optional(),
    includesVideoGame: z.boolean().optional(), unusualPaymentTerms: z.boolean().optional()
  }).optional().default({})
});
const lookupSchema = z.object({ documentNumber: z.string().trim().min(1, "Missing documentNumber in request body") });

async function buildForVendor(
  repository: ContractCheckRepository, vendor: VendorCandidate,
  flags: AdditionalFlags, purposeCode: string
) {
  const docs = await repository.findVendorDocuments(vendor.id);
  const masterContracts = buildMasterContractSummary(docs);
  const purpose = findPurpose(purposeCode);
  const purposeResult = buildPurposeResult(flags, masterContracts, purpose);
  return {
    ok: true,
    counterparty: {
      vendorId: vendor.id, vendorCode: vendor.vendorCode ?? "", vendorName: vendor.vendorName ?? "",
      entityType: vendor.entityType ?? "", tradeName: vendor.tradeName ?? "", penName: vendor.penName ?? ""
    },
    masterContracts,
    licenseConditions: buildLicenseConditions(docs),
    publicationConditions: buildPublicationConditions(docs),
    purposeResult,
    suggestedAction: buildSuggestedAction(purposeResult)
  };
}

export function createContractCheckRouter(repository: ContractCheckRepository | undefined) {
  const router = Router();

  router.get("/contract-check/purposes", (_request, response) => {
    // V1 は contract_purposes 表（静的シード）を返していた。V2 は TS 定数（grant 不要）。
    return response.status(200).json(CONTRACT_PURPOSES.map((p) => ({
      purpose_code: p.purposeCode, purpose_group: p.purposeGroup, purpose_label: p.purposeLabel,
      category: p.category, required_contract_type: p.requiredContractType,
      default_document_type: p.defaultDocumentType, sort_order: p.sortOrder,
      flow_direction: p.flowDirection, high_risk_flag: p.highRiskFlag
    })));
  });

  router.post("/contract-check/search", async (request, response, next) => {
    try {
      if (!repository) return response.status(503).json({ ok: false, error: "contract check is not available" });
      const parsed = searchSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return response.status(400).json({ ok: false, error: parsed.error.issues[0]?.message ?? "invalid request" });
      }
      const input = parsed.data;
      const flags = input.additionalFlags as AdditionalFlags;

      if (input.vendorId != null) {
        const vendor = await repository.findVendorById(input.vendorId);
        if (!vendor) return response.status(200).json(notFoundResult(findPurpose(input.purposeCode)));
        return response.status(200).json(await buildForVendor(repository, vendor, flags, input.purposeCode));
      }
      const candidates = await repository.searchVendors(input.counterpartyName, 10);
      if (candidates.length === 0) {
        return response.status(200).json(notFoundResult(findPurpose(input.purposeCode)));
      }
      if (candidates.length === 1) {
        return response.status(200).json(await buildForVendor(repository, candidates[0], flags, input.purposeCode));
      }
      // 複数候補：V1 は全候補フル構築（N×4クエリ）だったが、V2 は5件までに制限（port spec §6）。
      const results = await Promise.all(candidates.slice(0, 5).map((c) =>
        buildForVendor(repository, c, flags, input.purposeCode)));
      return response.status(200).json({
        ok: true, multiple: true, count: candidates.length,
        message: "複数の取引先候補が見つかりました。確認したい候補を選択してください。",
        results
      });
    } catch (error) { return next(error); }
  });

  router.post("/contract-check/lookup-number", async (request, response, next) => {
    try {
      if (!repository) return response.status(503).json({ ok: false, error: "contract check is not available" });
      const parsed = lookupSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return response.status(400).json({ ok: false, error: parsed.error.issues[0]?.message ?? "invalid request" });
      }
      const found = await repository.lookupByNumber(parsed.data.documentNumber);
      if (!found) return response.status(200).json({ ok: true, found: false });
      return response.status(200).json({ ok: true, found: true, ...found });
    } catch (error) { return next(error); }
  });

  return router;
}
