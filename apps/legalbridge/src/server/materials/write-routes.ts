import { Router } from "express";
import { z } from "zod";
import { materialCreateSchema, materialUpdateSchema } from "./write-schema.js";
import { MaterialWriteError, type MaterialWriteRepository } from "./write-repository.js";

const idPath = z.object({ id: z.coerce.number().int().positive() });
function editorAllowed(role: string | undefined) { return role === "admin" || role === "legal"; }
function unavailable(r: import("express").Response) {
  return r.status(503).json({ error: "material editing is not enabled", code: "MATERIAL_WRITE_UNAVAILABLE" });
}
function forbidden(r: import("express").Response) {
  return r.status(403).json({ error: "法務または管理者のみが素材を編集できます", code: "MATERIAL_EDIT_FORBIDDEN" });
}
function statusFor(code: string) {
  if (code === "MATERIAL_NOT_FOUND") return 404;
  if (code === "MATERIAL_CONFLICT") return 409;
  if (code === "MATERIAL_WORK_NOT_FOUND" || code === "MATERIAL_REQUIRED") return 422;
  return 400;
}
function handle(error: unknown, r: import("express").Response, next: import("express").NextFunction) {
  if (error instanceof MaterialWriteError) return r.status(statusFor(error.code)).json({ error: error.message, code: error.code });
  if (error instanceof z.ZodError) return r.status(400).json({ error: "invalid request", issues: error.issues });
  return next(error);
}

export function createMaterialWriteRouter(materials: MaterialWriteRepository | undefined, writeEnabled = false) {
  const router = Router();

  // 素材フォームの作品ピッカー用（読取専用・編集者ロール限定）。
  router.get("/materials/works", async (request, response, next) => {
    try {
      if (!materials) return unavailable(response);
      if (!editorAllowed(response.locals.currentUser?.role)) return forbidden(response);
      const q = typeof request.query.q === "string" ? request.query.q : "";
      const works = await materials.listWorks(q);
      return response.status(200).json({ works });
    } catch (error) { return handle(error, response, next); }
  });

  router.get("/materials/:id", async (request, response, next) => {
    try {
      if (!materials) return unavailable(response);
      if (!editorAllowed(response.locals.currentUser?.role)) return forbidden(response);
      const { id } = idPath.parse(request.params);
      const record = await materials.find(id);
      if (!record) return response.status(404).json({ error: "指定した素材が見つかりません", code: "MATERIAL_NOT_FOUND" });
      return response.status(200).json({ material: record });
    } catch (error) { return handle(error, response, next); }
  });

  router.post("/materials/validate", (request, response) => {
    const result = materialCreateSchema.safeParse(request.body);
    if (!result.success) {
      return response.status(400).json({ ok: false, errors: result.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })) });
    }
    return response.status(200).json({ ok: true });
  });

  router.post("/materials", async (request, response, next) => {
    try {
      if (!writeEnabled || !materials) return unavailable(response);
      if (!editorAllowed(response.locals.currentUser?.role)) return forbidden(response);
      const created = await materials.create(materialCreateSchema.parse(request.body));
      return response.status(201).json(created);
    } catch (error) { return handle(error, response, next); }
  });

  router.patch("/materials/:id", async (request, response, next) => {
    try {
      if (!writeEnabled || !materials) return unavailable(response);
      if (!editorAllowed(response.locals.currentUser?.role)) return forbidden(response);
      const { id } = idPath.parse(request.params);
      const updated = await materials.update(id, materialUpdateSchema.parse(request.body));
      return response.status(200).json(updated);
    } catch (error) { return handle(error, response, next); }
  });

  return router;
}
