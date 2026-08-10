import { Router } from "express";
import { z } from "zod";
import { documentVoidSchema } from "./document-void-schema.js";
import { DocumentVoidError, type DocumentVoidRepository } from "./document-void-repository.js";

// 発行文書の void（破壊的・Phase 10-2）。guarded-write（既定OFF・確認トークン
// COMMIT_DOCUMENT_VOID・admin/legal のみ）。オプションで Backlog へ void を書き戻す。
const idPath = z.object({ id: z.coerce.number().int().positive() });

function editorAllowed(role: string | undefined) { return role === "admin" || role === "legal"; }
function forbidden(r: import("express").Response) {
  return r.status(403).json({ error: "法務または管理者のみが void できます", code: "DOCUMENT_VOID_FORBIDDEN" });
}
function statusFor(code: string) {
  if (code === "DOCUMENT_VOID_NOT_FOUND") return 404;
  if (code === "DOCUMENT_VOID_FORBIDDEN_DB") return 503;
  return 400;
}
function handle(error: unknown, r: import("express").Response, next: import("express").NextFunction) {
  if (error instanceof DocumentVoidError) return r.status(statusFor(error.code)).json({ error: error.message, code: error.code });
  if (error instanceof z.ZodError) return r.status(400).json({ error: "invalid request", issues: error.issues });
  return next(error);
}

export interface DocumentVoidNotifier {
  (issueKey: string, text: string): Promise<void>;
}

export function createDocumentVoidRouter(
  repository: DocumentVoidRepository | undefined,
  writeEnabled = false,
  notify?: DocumentVoidNotifier
) {
  const router = Router();

  router.post("/documents/:id/void", async (request, response, next) => {
    try {
      if (!writeEnabled || !repository) {
        return response.status(503).json({ error: "document void is not enabled", code: "DOCUMENT_VOID_WRITE_UNAVAILABLE" });
      }
      if (!editorAllowed(response.locals.currentUser?.role)) return forbidden(response);
      const { id } = idPath.parse(request.params);
      const input = documentVoidSchema.parse(request.body ?? {});
      const actor = String(response.locals.currentUser?.email ?? "unknown");
      const result = await repository.void(id, input, actor);
      // Backlog 書き戻しはベストエフォート（失敗しても void は成立済み）。既 void はスキップ。
      if (notify && result.issueKey && !result.alreadyVoided) {
        const reasonLine = input.reason?.trim() ? `\n理由: ${input.reason.trim()}` : "";
        void notify(result.issueKey,
          `🗑️ 文書を void しました: ${result.documentNumber || "(採番なし)"}${reasonLine}` +
          `\n→ 紐づく実績 ${result.voidedEvents} 件を取消しました。`
        ).catch(() => undefined);
      }
      return response.status(200).json(result);
    } catch (error) { return handle(error, response, next); }
  });

  return router;
}
