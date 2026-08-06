import { Router } from "express";
import { z } from "zod";
import { workCreateSchema, workUpdateSchema } from "./write-schema.js";
import { WorkWriteError, type WorkWriteRepository } from "./write-repository.js";

const idPath = z.object({ id: z.coerce.number().int().positive() });
function editorAllowed(role: string | undefined) { return role === "admin" || role === "legal"; }
function unavailable(r: import("express").Response) {
  return r.status(503).json({ error: "work editing is not enabled", code: "WORK_WRITE_UNAVAILABLE" });
}
function forbidden(r: import("express").Response) {
  return r.status(403).json({ error: "法務または管理者のみが作品を編集できます", code: "WORK_EDIT_FORBIDDEN" });
}
function statusFor(code: string) {
  if (code === "WORK_NOT_FOUND") return 404;
  if (code === "WORK_CONFLICT") return 409;
  if (code === "WORK_REQUIRED") return 422;
  if (code === "WORK_LINEAGE_CYCLE") return 422;
  return 400;
}
function handle(error: unknown, r: import("express").Response, next: import("express").NextFunction) {
  if (error instanceof WorkWriteError) return r.status(statusFor(error.code)).json({ error: error.message, code: error.code });
  if (error instanceof z.ZodError) return r.status(400).json({ error: "invalid request", issues: error.issues });
  return next(error);
}

export function createWorkWriteRouter(works: WorkWriteRepository | undefined, writeEnabled = false) {
  const router = Router();

  router.get("/works/:id", async (request, response, next) => {
    try {
      if (!works) return unavailable(response);
      if (!editorAllowed(response.locals.currentUser?.role)) return forbidden(response);
      const { id } = idPath.parse(request.params);
      const record = await works.find(id);
      if (!record) return response.status(404).json({ error: "指定した作品が見つかりません", code: "WORK_NOT_FOUND" });
      return response.status(200).json({ work: record });
    } catch (error) { return handle(error, response, next); }
  });

  router.post("/works/validate", (request, response) => {
    const result = workCreateSchema.safeParse(request.body);
    if (!result.success) {
      return response.status(400).json({ ok: false, errors: result.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })) });
    }
    return response.status(200).json({ ok: true });
  });

  router.post("/works", async (request, response, next) => {
    try {
      if (!writeEnabled || !works) return unavailable(response);
      if (!editorAllowed(response.locals.currentUser?.role)) return forbidden(response);
      const created = await works.create(workCreateSchema.parse(request.body));
      return response.status(201).json(created);
    } catch (error) { return handle(error, response, next); }
  });

  // Bulk import: validate each row, insert independently, report per-row.
  router.post("/works/import", async (request, response, next) => {
    try {
      if (!writeEnabled || !works) return unavailable(response);
      if (!editorAllowed(response.locals.currentUser?.role)) return forbidden(response);
      const body = z.object({
        rows: z.array(z.record(z.string(), z.unknown())).min(1, "取込む行がありません").max(500)
      }).parse(request.body);
      const inserted: Array<{ index: number; id: number; workCode: string | null }> = [];
      const failed: Array<{ index: number; error: string }> = [];
      for (let index = 0; index < body.rows.length; index += 1) {
        const parsed = workCreateSchema.safeParse(body.rows[index]);
        if (!parsed.success) {
          failed.push({ index, error: parsed.error.issues.map((i) => i.message).join(" / ") });
          continue;
        }
        try {
          const created = await works.create(parsed.data);
          inserted.push({ index, id: created.id, workCode: created.workCode });
        } catch (error) {
          const message = error instanceof WorkWriteError ? error.message
            : error instanceof Error ? error.message : "登録に失敗しました";
          failed.push({ index, error: message });
        }
      }
      return response.status(inserted.length ? 201 : 422).json({
        insertedCount: inserted.length, failedCount: failed.length, inserted, failed
      });
    } catch (error) {
      return handle(error, response, next);
    }
  });

  router.patch("/works/:id", async (request, response, next) => {
    try {
      if (!writeEnabled || !works) return unavailable(response);
      if (!editorAllowed(response.locals.currentUser?.role)) return forbidden(response);
      const { id } = idPath.parse(request.params);
      const updated = await works.update(id, workUpdateSchema.parse(request.body));
      return response.status(200).json(updated);
    } catch (error) { return handle(error, response, next); }
  });

  return router;
}
