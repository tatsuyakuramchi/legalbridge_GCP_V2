import { Router } from "express";
import { z } from "zod";
import { vendorMergeSchema } from "./merge-schema.js";
import { VendorMergeError, type VendorMergeRepository } from "./merge-repository.js";

// 取引先マージ（名寄せ）。プレビューは読取（admin/legal・GRANT不要）、
// 実行は guarded-write（既定OFF・確認トークン・grant 018）。DELETEなし。
function editorAllowed(role: string | undefined) { return role === "admin" || role === "legal"; }
function forbidden(r: import("express").Response) {
  return r.status(403).json({ error: "法務または管理者のみが名寄せを実行できます", code: "VENDOR_MERGE_FORBIDDEN" });
}
function statusFor(code: string) {
  if (code === "VENDOR_MERGE_TARGET_NOT_FOUND" || code === "VENDOR_MERGE_SOURCE_NOT_FOUND") return 404;
  if (code === "VENDOR_MERGE_FORBIDDEN_DB") return 503;
  return 400;
}
function handle(error: unknown, r: import("express").Response, next: import("express").NextFunction) {
  if (error instanceof VendorMergeError) return r.status(statusFor(error.code)).json({ error: error.message, code: error.code });
  if (error instanceof z.ZodError) return r.status(400).json({ error: "invalid request", issues: error.issues });
  return next(error);
}

export function createVendorMergeRouter(repository: VendorMergeRepository | undefined, writeEnabled = false) {
  const router = Router();

  router.get("/vendor-merge/preview", async (request, response, next) => {
    try {
      if (!repository) return response.status(503).json({ error: "vendor merge is not available", code: "VENDOR_MERGE_UNAVAILABLE" });
      if (!editorAllowed(response.locals.currentUser?.role)) return forbidden(response);
      const { targetId, sourceId } = z.object({
        targetId: z.coerce.number().int().positive(),
        sourceId: z.coerce.number().int().positive()
      }).parse(request.query);
      if (targetId === sourceId) return response.status(400).json({ error: "同一の取引先はマージできません", code: "VENDOR_MERGE_SAME" });
      const preview = await repository.preview(targetId, sourceId);
      return response.status(200).json({ preview, writeEnabled });
    } catch (error) { return handle(error, response, next); }
  });

  router.post("/vendor-merge", async (request, response, next) => {
    try {
      if (!writeEnabled || !repository) return response.status(503).json({ error: "vendor merge is not enabled", code: "VENDOR_MERGE_WRITE_UNAVAILABLE" });
      if (!editorAllowed(response.locals.currentUser?.role)) return forbidden(response);
      const result = await repository.merge(vendorMergeSchema.parse(request.body));
      return response.status(200).json(result);
    } catch (error) { return handle(error, response, next); }
  });

  return router;
}
