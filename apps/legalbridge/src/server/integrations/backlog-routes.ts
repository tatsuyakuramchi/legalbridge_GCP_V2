import { Router } from "express";
import { z } from "zod";
import { BacklogApiError, type BacklogReadClient, type BacklogWriteClient } from "./backlog-web-api.js";

export const BACKLOG_COMMENT_CONFIRMATION = "COMMIT_BACKLOG_COMMENT";
const commentSchema = z.object({
  content: z.string().trim().min(1, "コメント本文は必須です").max(10000),
  confirmation: z.string()
}).refine((v) => v.confirmation === BACKLOG_COMMENT_CONFIRMATION, {
  message: `確認トークン ${BACKLOG_COMMENT_CONFIRMATION} が必要です`, path: ["confirmation"]
});

// Backlog 課題一覧（依頼取込・Phase 3・読み取り・admin/legal限定）。
// BACKLOG_MODE=readonly＋接続情報がある時のみ client が渡る。無ければ enabled:false。
// 書き戻しは含まない（別スライス・guarded）。
export function createBacklogRequestRouter(client?: BacklogReadClient) {
  const router = Router();

  router.get("/backlog/issues", async (request, response, next) => {
    try {
      const role = response.locals.currentUser?.role;
      if (role !== "admin" && role !== "legal") {
        return response.status(403).json({ error: "legal or administrator access is required", code: "BACKLOG_ROLE_REQUIRED" });
      }
      if (!client) {
        return response.status(200).json({ enabled: false, issues: [] });
      }
      const query = z.object({
        keyword: z.string().max(200).optional(),
        count: z.coerce.number().int().min(1).max(100).optional()
      }).parse(request.query);
      const issues = await client.getIssues(query);
      return response.status(200).json({ enabled: true, issues });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return response.status(400).json({ error: "invalid request", issues: error.issues });
      }
      if (error instanceof BacklogApiError) {
        return response.status(502).json({ error: "Backlog API request failed", code: "BACKLOG_API_ERROR", status: error.status });
      }
      next(error);
    }
  });

  return router;
}

// Backlog書き戻し：コメント投稿（Phase 3・guarded・既定OFF・確認トークン・admin/legal）。
// BACKLOG_MODE=live には依存しない独立capability（既存workerとの棲み分けのため、
// 明示有効化時のみ動作）。ステータス/カスタム属性同期は別スライス（要固有ID判断）。
export function createBacklogCommentRouter(client?: BacklogWriteClient, writeEnabled = false) {
  const router = Router();

  router.post("/backlog/issues/:issueKey/comments", async (request, response, next) => {
    try {
      const role = response.locals.currentUser?.role;
      if (role !== "admin" && role !== "legal") {
        return response.status(403).json({ error: "legal or administrator access is required", code: "BACKLOG_ROLE_REQUIRED" });
      }
      if (!writeEnabled || !client) {
        return response.status(503).json({ error: "Backlog comment write-back is not enabled", code: "BACKLOG_COMMENT_WRITE_UNAVAILABLE" });
      }
      const { issueKey } = z.object({ issueKey: z.string().trim().min(1).max(64) }).parse(request.params);
      const { content } = commentSchema.parse(request.body);
      const result = await client.addComment(issueKey, content);
      return response.status(201).json({ ok: true, commentId: result.id, issueKey });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return response.status(400).json({ error: "invalid request", issues: error.issues });
      }
      if (error instanceof BacklogApiError) {
        return response.status(502).json({ error: "Backlog API request failed", code: "BACKLOG_API_ERROR", status: error.status });
      }
      next(error);
    }
  });

  return router;
}
