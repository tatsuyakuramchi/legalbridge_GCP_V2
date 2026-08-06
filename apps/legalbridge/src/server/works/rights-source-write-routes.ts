import { Router } from "express";
import { z } from "zod";
import { rightsSourceCreateSchema, rightsSourceUpdateSchema, rightsSourceImportRowSchema } from "./rights-source-write-schema.js";
import { RightsSourceWriteError, type RightsSourceWriteRepository } from "./rights-source-write-repository.js";
import { bulkImport } from "../import/bulk.js";

// 権利ソース書込み（guarded-write・既定OFF・admin/legal限定・DELETEなし）。
const idPath = z.object({ id: z.coerce.number().int().positive() });
function editorAllowed(role: string | undefined) { return role === "admin" || role === "legal"; }
function unavailable(r: import("express").Response) {
  return r.status(503).json({ error: "rights source editing is not enabled", code: "RIGHTS_SOURCE_WRITE_UNAVAILABLE" });
}
function forbidden(r: import("express").Response) {
  return r.status(403).json({ error: "法務または管理者のみが権利ソースを編集できます", code: "RIGHTS_SOURCE_EDIT_FORBIDDEN" });
}
function statusFor(code: string) {
  if (code === "RIGHTS_SOURCE_NOT_FOUND") return 404;
  if (code === "RIGHTS_SOURCE_INVALID_REF") return 422;
  if (code === "RIGHTS_SOURCE_REQUIRED") return 422;
  return 400;
}
function handle(error: unknown, r: import("express").Response, next: import("express").NextFunction) {
  if (error instanceof RightsSourceWriteError) return r.status(statusFor(error.code)).json({ error: error.message, code: error.code });
  if (error instanceof z.ZodError) return r.status(400).json({ error: "invalid request", issues: error.issues });
  return next(error);
}

export function createRightsSourceWriteRouter(repository: RightsSourceWriteRepository | undefined, writeEnabled = false) {
  const router = Router();

  router.post("/rights-sources/validate", (request, response) => {
    const result = rightsSourceCreateSchema.safeParse(request.body);
    if (!result.success) {
      return response.status(400).json({ ok: false, errors: result.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })) });
    }
    return response.status(200).json({ ok: true });
  });

  router.post("/rights-sources", async (request, response, next) => {
    try {
      if (!writeEnabled || !repository) return unavailable(response);
      if (!editorAllowed(response.locals.currentUser?.role)) return forbidden(response);
      const created = await repository.create(rightsSourceCreateSchema.parse(request.body));
      return response.status(201).json(created);
    } catch (error) { return handle(error, response, next); }
  });

  router.post("/rights-sources/import", async (request, response, next) => {
    try {
      if (!writeEnabled || !repository) return unavailable(response);
      if (!editorAllowed(response.locals.currentUser?.role)) return forbidden(response);
      const body = z.object({
        rows: z.array(z.record(z.string(), z.unknown())).min(1, "取込む行がありません").max(500)
      }).parse(request.body);
      const report = await bulkImport(body.rows, rightsSourceImportRowSchema, (input) => repository.create(input));
      return response.status(report.insertedCount ? 201 : 422).json(report);
    } catch (error) { return handle(error, response, next); }
  });

  router.patch("/rights-sources/:id", async (request, response, next) => {
    try {
      if (!writeEnabled || !repository) return unavailable(response);
      if (!editorAllowed(response.locals.currentUser?.role)) return forbidden(response);
      const { id } = idPath.parse(request.params);
      const updated = await repository.update(id, rightsSourceUpdateSchema.parse(request.body));
      return response.status(200).json(updated);
    } catch (error) { return handle(error, response, next); }
  });

  return router;
}
