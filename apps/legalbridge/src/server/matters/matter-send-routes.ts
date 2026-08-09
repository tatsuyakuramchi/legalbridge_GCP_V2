import { Router } from "express";
import { z } from "zod";
import { MatterWriteError } from "./write-repository.js";
import {
  SEND_CHANNELS, SEND_STATUSES, type MatterSendRepository
} from "./matter-send-repository.js";

const idPath = z.object({ id: z.coerce.number().int().positive() });
const recordBody = z.object({
  documentId: z.coerce.number().int().positive(),
  channel: z.enum(SEND_CHANNELS).default("email"),
  recipient: z.string().trim().max(500).nullable().optional(),
  status: z.enum(SEND_STATUSES).default("sent"),
  subject: z.string().trim().max(1000).nullable().optional(),
  bodyPreview: z.string().trim().max(4000).nullable().optional(),
  messageId: z.string().trim().max(500).nullable().optional(),
  remarks: z.string().trim().max(2000).nullable().optional()
});

function editorAllowed(role: string | undefined) { return role === "admin" || role === "legal"; }

export function createMatterSendRouter(
  sends: MatterSendRepository | undefined,
  writeEnabled = false
) {
  const router = Router();

  // 送信履歴の一覧（read・admin/legal）。台帳未設定なら enabled:false。
  router.get("/matters/:id/sends", async (request, response, next) => {
    try {
      if (!editorAllowed(response.locals.currentUser?.role)) {
        return response.status(403).json({ error: "法務または管理者のみが参照できます", code: "MATTER_SEND_FORBIDDEN" });
      }
      if (!sends) return response.status(200).json({ enabled: false, sends: [] });
      const { id } = idPath.parse(request.params);
      return response.status(200).json({ enabled: true, sends: await sends.list(id) });
    } catch (error) {
      if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
      return next(error);
    }
  });

  // 送信実績の記録（append・guarded-write・案件編集権限を共有）。
  router.post("/matters/:id/sends", async (request, response, next) => {
    try {
      if (!writeEnabled || !sends) {
        return response.status(503).json({ error: "matter editing is not enabled", code: "MATTER_WRITE_UNAVAILABLE" });
      }
      if (!editorAllowed(response.locals.currentUser?.role)) {
        return response.status(403).json({ error: "法務または管理者のみが記録できます", code: "MATTER_EDIT_FORBIDDEN" });
      }
      const { id } = idPath.parse(request.params);
      const input = recordBody.parse(request.body);
      const send = await sends.record(id, {
        ...input, sentBy: response.locals.currentUser?.email ?? null
      });
      return response.status(201).json({ send });
    } catch (error) {
      if (error instanceof MatterWriteError) {
        const status = error.code === "MATTER_SEND_GRANT_MISSING" ? 503
          : error.code === "MATTER_REFERENCE_INVALID" ? 422 : 400;
        return response.status(status).json({ error: error.message, code: error.code });
      }
      if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
      return next(error);
    }
  });

  return router;
}
