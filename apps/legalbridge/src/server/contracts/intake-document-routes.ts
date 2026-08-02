import { Router } from "express";
import { z } from "zod";
import type { DraftRepository } from "../documents/draft-repository.js";
import type { TemplateRepository } from "../documents/template-repository.js";
import {
  ContractIntakeDocumentBridgeError,
  contractIntakeDocumentTypes,
  prepareContractIntakeDocumentDrafts
} from "./intake-document-bridge.js";
import type {
  ContractIntakeDocumentSourceRepository
} from "./intake-document-repository.js";

const pathSchema = z.object({
  documentId: z.coerce.number().int().positive()
});
const requestSchema = z.object({
  templateType: z.enum(contractIntakeDocumentTypes)
});
const listQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional().default(50)
});

export function createContractIntakeDocumentRouter(
  sources: ContractIntakeDocumentSourceRepository | undefined,
  templates: TemplateRepository,
  drafts: DraftRepository,
  writeEnabled = false
) {
  const router = Router();

  router.get("/contract-intakes", async (request, response, next) => {
    try {
      if (!sources) {
        return response.status(503).json({
          error: "contract intake registry is unavailable",
          code: "CONTRACT_INTAKE_REGISTRY_UNAVAILABLE"
        });
      }
      if (response.locals.currentUser?.role !== "admin") {
        return response.status(403).json({
          error: "administrator approval is required",
          code: "CONTRACT_INTAKE_ADMIN_REQUIRED"
        });
      }
      const { limit } = listQuerySchema.parse(request.query);
      const items = await sources.list(limit);
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

  router.post(
    "/contract-intakes/:documentId/document-drafts",
    async (request, response, next) => {
      try {
        if (!writeEnabled || !sources) {
          return response.status(503).json({
            error: "contract intake document bridge is unavailable",
            code: "CONTRACT_INTAKE_DOCUMENT_BRIDGE_UNAVAILABLE"
          });
        }
        if (response.locals.currentUser?.role !== "admin") {
          return response.status(403).json({
            error: "administrator approval is required",
            code: "CONTRACT_INTAKE_ADMIN_REQUIRED"
          });
        }

        const { documentId } = pathSchema.parse(request.params);
        const { templateType } = requestSchema.parse(request.body);
        const source = await sources.find(documentId);
        if (!source) {
          return response.status(404).json({
            error: "registered contract intake document not found",
            code: "CONTRACT_INTAKE_DOCUMENT_NOT_FOUND"
          });
        }

        const prepared = await prepareContractIntakeDocumentDrafts(
          source,
          templateType,
          drafts,
          templates,
          response.locals.currentUser.email
        );
        const created = prepared.some((item) => item.created);
        return response.status(created ? 201 : 200).json({
          templateType,
          drafts: prepared.map((item) => ({
            id: item.draft.id,
            issueKey: item.draft.issueKey,
            templateType: item.draft.templateType,
            updatedAt: item.draft.updatedAt,
            created: item.created,
            label: item.label,
            counterpartyVendorId: item.counterpartyVendorId,
            counterpartyName: item.counterpartyName
          })),
          reviewRequired: templateType === "royalty_statement"
            ? [
                "対象期間",
                "実績売上額",
                "利用許諾料",
                "控除・源泉徴収",
                "支払期限"
              ]
            : [
                "当事者情報",
                "許諾範囲",
                "金銭条件",
                "再許諾条件",
                "発行日"
              ],
          integrations: {
            backlog: "disabled",
            slack: "disabled",
            drive: "disabled"
          }
        });
      } catch (error) {
        if (error instanceof ContractIntakeDocumentBridgeError) {
          const status = error.code === "OUTBOUND_CONDITIONS_REQUIRED"
            ? 422
            : error.code === "TARGET_TEMPLATE_NOT_FOUND"
              ? 503
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
    }
  );

  return router;
}
