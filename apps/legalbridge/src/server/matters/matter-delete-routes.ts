import { Router } from "express";
import { z } from "zod";
import { matterDeleteSchema } from "./matter-delete-schema.js";
import { MatterDeleteError, type MatterDeleteRepository } from "./matter-delete-repository.js";

// 案件・タスク削除（破壊的・Phase 8-6）。プレビューは読取（admin/legal・GRANT不要）、
// 案件削除は guarded-write（既定OFF・確認トークン COMMIT_MATTER_DELETE）。タスク削除は合言葉不要。
const idPath = z.object({ id: z.coerce.number().int().positive() });
const taskPath = z.object({
  id: z.coerce.number().int().positive(),
  taskId: z.coerce.number().int().positive()
});

function editorAllowed(role: string | undefined) { return role === "admin" || role === "legal"; }
function forbidden(r: import("express").Response) {
  return r.status(403).json({ error: "法務または管理者のみが削除できます", code: "MATTER_DELETE_FORBIDDEN" });
}
function statusFor(code: string) {
  if (code === "MATTER_DELETE_NOT_FOUND" || code === "MATTER_TASK_NOT_FOUND") return 404;
  if (code === "MATTER_DELETE_FORBIDDEN_DB") return 503;
  if (code === "MATTER_TASK_PRIMARY") return 409;
  if (code === "MATTER_DELETE_REFERENCED") return 409;
  return 400;
}
function handle(error: unknown, r: import("express").Response, next: import("express").NextFunction) {
  if (error instanceof MatterDeleteError) return r.status(statusFor(error.code)).json({ error: error.message, code: error.code });
  if (error instanceof z.ZodError) return r.status(400).json({ error: "invalid request", issues: error.issues });
  return next(error);
}

export function createMatterDeleteRouter(repository: MatterDeleteRepository | undefined, writeEnabled = false) {
  const router = Router();

  // 削除プレビュー（連鎖削除・解除の件数）。read・admin/legal・書込無効でも可。
  router.get("/matters/:id/delete-preview", async (request, response, next) => {
    try {
      if (!repository) return response.status(503).json({ error: "matter delete is not available", code: "MATTER_DELETE_UNAVAILABLE" });
      if (!editorAllowed(response.locals.currentUser?.role)) return forbidden(response);
      const { id } = idPath.parse(request.params);
      const preview = await repository.preview(id);
      return response.status(200).json({ preview, writeEnabled });
    } catch (error) { return handle(error, response, next); }
  });

  // 案件削除（guarded・確認トークン）。
  router.delete("/matters/:id", async (request, response, next) => {
    try {
      if (!writeEnabled || !repository) return response.status(503).json({ error: "matter delete is not enabled", code: "MATTER_DELETE_WRITE_UNAVAILABLE" });
      if (!editorAllowed(response.locals.currentUser?.role)) return forbidden(response);
      const { id } = idPath.parse(request.params);
      const input = matterDeleteSchema.parse(request.body ?? {});
      const result = await repository.deleteMatter(id, input);
      return response.status(200).json(result);
    } catch (error) { return handle(error, response, next); }
  });

  // タスク単体削除（guarded・合言葉不要・代表タスクは409）。
  router.delete("/matters/:id/tasks/:taskId", async (request, response, next) => {
    try {
      if (!writeEnabled || !repository) return response.status(503).json({ error: "matter delete is not enabled", code: "MATTER_DELETE_WRITE_UNAVAILABLE" });
      if (!editorAllowed(response.locals.currentUser?.role)) return forbidden(response);
      const { id, taskId } = taskPath.parse(request.params);
      const result = await repository.deleteTask(id, taskId);
      return response.status(200).json(result);
    } catch (error) { return handle(error, response, next); }
  });

  return router;
}
