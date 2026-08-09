import { Router } from "express";
import { z } from "zod";
import { matterMergeSchema } from "./matter-merge-schema.js";
import { MatterMergeError, type MatterMergeRepository } from "./matter-merge-repository.js";

// 案件マージ（名寄せ）。プレビューは読取（admin/legal・GRANT不要）、
// 実行は guarded-write（既定OFF・確認トークン COMMIT_MATTER_MERGE）。source はアーカイブ（DELETEなし）。
function editorAllowed(role: string | undefined) { return role === "admin" || role === "legal"; }
function forbidden(r: import("express").Response) {
  return r.status(403).json({ error: "法務または管理者のみが名寄せを実行できます", code: "MATTER_MERGE_FORBIDDEN" });
}
function statusFor(code: string) {
  if (code === "MATTER_MERGE_TARGET_NOT_FOUND" || code === "MATTER_MERGE_SOURCE_NOT_FOUND") return 404;
  if (code === "MATTER_MERGE_FORBIDDEN_DB") return 503;
  return 400;
}
function handle(error: unknown, r: import("express").Response, next: import("express").NextFunction) {
  if (error instanceof MatterMergeError) return r.status(statusFor(error.code)).json({ error: error.message, code: error.code });
  if (error instanceof z.ZodError) return r.status(400).json({ error: "invalid request", issues: error.issues });
  return next(error);
}

export function createMatterMergeRouter(repository: MatterMergeRepository | undefined, writeEnabled = false) {
  const router = Router();

  router.get("/matter-merge/preview", async (request, response, next) => {
    try {
      if (!repository) return response.status(503).json({ error: "matter merge is not available", code: "MATTER_MERGE_UNAVAILABLE" });
      if (!editorAllowed(response.locals.currentUser?.role)) return forbidden(response);
      const { targetId, sourceId } = z.object({
        targetId: z.coerce.number().int().positive(),
        sourceId: z.coerce.number().int().positive()
      }).parse(request.query);
      if (targetId === sourceId) return response.status(400).json({ error: "同一の案件はマージできません", code: "MATTER_MERGE_SAME" });
      const preview = await repository.preview(targetId, sourceId);
      return response.status(200).json({ preview, writeEnabled });
    } catch (error) { return handle(error, response, next); }
  });

  router.post("/matter-merge", async (request, response, next) => {
    try {
      if (!writeEnabled || !repository) return response.status(503).json({ error: "matter merge is not enabled", code: "MATTER_MERGE_WRITE_UNAVAILABLE" });
      if (!editorAllowed(response.locals.currentUser?.role)) return forbidden(response);
      const result = await repository.merge(matterMergeSchema.parse(request.body));
      return response.status(200).json(result);
    } catch (error) { return handle(error, response, next); }
  });

  return router;
}
