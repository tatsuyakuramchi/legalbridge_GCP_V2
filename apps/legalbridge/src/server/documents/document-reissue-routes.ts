import { Router } from "express";
import { z } from "zod";
import { documentReissueSchema } from "./document-reissue-schema.js";
import { DocumentReissueError, type DocumentReissueRepository } from "./document-reissue-repository.js";
import { buildDocumentConditionInputs, hasConditionSyncData } from "./condition-sync.js";
import type { ConditionSyncRepository } from "./condition-sync-repository.js";

// 文書の再発行（破壊的・Phase 10-1b）。guarded-write（既定OFF・確認トークン
// COMMIT_DOCUMENT_REISSUE・admin/legal のみ）。オプションで Backlog へ再発行を書き戻す。
const idPath = z.object({ id: z.coerce.number().int().positive() });

function editorAllowed(role: string | undefined) { return role === "admin" || role === "legal"; }
function forbidden(r: import("express").Response) {
  return r.status(403).json({ error: "法務または管理者のみが再発行できます", code: "DOCUMENT_REISSUE_FORBIDDEN" });
}
function statusFor(code: string) {
  if (code === "DOCUMENT_REISSUE_NOT_FOUND") return 404;
  if (code === "DOCUMENT_REISSUE_FORBIDDEN_DB") return 503;
  if (code === "DOCUMENT_REISSUE_SOURCE_VOIDED" || code === "DOCUMENT_REISSUE_UNNUMBERED") return 409;
  return 400;
}
function handle(error: unknown, r: import("express").Response, next: import("express").NextFunction) {
  if (error instanceof DocumentReissueError) return r.status(statusFor(error.code)).json({ error: error.message, code: error.code });
  if (error instanceof z.ZodError) return r.status(400).json({ error: "invalid request", issues: error.issues });
  return next(error);
}

export interface DocumentReissueNotifier {
  (issueKey: string, text: string): Promise<void>;
}

export function createDocumentReissueRouter(
  repository: DocumentReissueRepository | undefined,
  writeEnabled = false,
  notify?: DocumentReissueNotifier,
  issueKeyOf?: (sourceId: number) => Promise<string | null>,
  // 条件明細の追従: 旧版の condition_lines を新版へ移設（実績の参照を保全）し、
  // 特例編集で formData が変わっていれば新版の内容で upsert し直す。
  conditionSync?: ConditionSyncRepository
) {
  const router = Router();

  router.post("/documents/:id/reissue", async (request, response, next) => {
    try {
      if (!writeEnabled || !repository) {
        return response.status(503).json({ error: "document reissue is not enabled", code: "DOCUMENT_REISSUE_WRITE_UNAVAILABLE" });
      }
      if (!editorAllowed(response.locals.currentUser?.role)) return forbidden(response);
      const { id } = idPath.parse(request.params);
      const input = documentReissueSchema.parse(request.body ?? {});
      const actor = String(response.locals.currentUser?.email ?? "unknown");
      const result = await repository.reissue(id, input, actor);

      // 条件明細の追従（ベストエフォート・失敗しても再発行は成立済み）。
      //   1) 旧版の行を新版文書へ移設＝condition_events の condition_line_id 参照を壊さない。
      //   2) 特例編集で formData が渡っていれば、新版の内容で置換 upsert（料率等の訂正を反映）。
      let conditionSyncWarning: string | undefined;
      let movedConditions = 0;
      if (conditionSync) {
        try {
          movedConditions = await conditionSync.moveConditions(id, result.newId);
          if (input.formData && hasConditionSyncData(input.formData)) {
            await conditionSync.upsertDocumentConditions(
              result.newId, buildDocumentConditionInputs(input.formData)
            );
          }
        } catch (error) {
          conditionSyncWarning = (error as { code?: string })?.code === "42501"
            ? "条件明細の追従権限が未付与です（grant 066）。適用後、新版の「条件明細を台帳へ同期」で反映できます"
            : `条件明細の追従に失敗しました（新版から手動同期できます）: ${String((error as Error)?.message ?? error).slice(0, 200)}`;
        }
      }
      // Backlog 書き戻しはベストエフォート（失敗しても再発行は成立済み）。
      if (notify && issueKeyOf) {
        void issueKeyOf(id).then((issueKey) => {
          if (!issueKey) return;
          const reasonLine = input.reason?.trim() ? `\n理由: ${input.reason.trim()}` : "";
          return notify(issueKey,
            `♻️ 文書を再発行しました: ${result.sourceNumber || "(採番なし)"} → ${result.newNumber}${reasonLine}` +
            `\n→ 旧版の実績 ${result.carriedEvents} 件を新版へ引き継ぎました（残高は変わりません）。`
          );
        }).catch(() => undefined);
      }
      return response.status(200).json({
        ...result,
        movedConditions,
        ...(conditionSyncWarning ? { conditionSyncWarning } : {})
      });
    } catch (error) { return handle(error, response, next); }
  });

  return router;
}
