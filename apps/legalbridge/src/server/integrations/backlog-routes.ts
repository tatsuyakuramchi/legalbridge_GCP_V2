import { Router } from "express";
import { z } from "zod";
import { BacklogApiError, type BacklogReadClient } from "./backlog-web-api.js";

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
