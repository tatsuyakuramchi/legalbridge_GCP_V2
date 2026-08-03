import { Router } from "express";
import { z } from "zod";
import {
  staffCreateSchema, staffUpdateSchema, StaffWriteError, type StaffRepository
} from "./repository.js";

const idPath = z.object({ id: z.coerce.number().int().positive() });

function editorAllowed(role: string | undefined) {
  return role === "admin" || role === "legal";
}
function forbidden(response: import("express").Response) {
  return response.status(403).json({ error: "法務または管理者のみが担当者を編集できます", code: "STAFF_EDIT_FORBIDDEN" });
}
function unavailable(response: import("express").Response) {
  return response.status(503).json({ error: "staff editing is not enabled", code: "STAFF_WRITE_UNAVAILABLE" });
}
function statusFor(code: string) {
  if (code === "STAFF_NOT_FOUND") return 404;
  if (code === "STAFF_CONFLICT") return 409;
  if (code === "STAFF_REQUIRED") return 422;
  return 400;
}
function handle(error: unknown, response: import("express").Response, next: import("express").NextFunction) {
  if (error instanceof StaffWriteError) return response.status(statusFor(error.code)).json({ error: error.message, code: error.code });
  if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
  return next(error);
}

export function createStaffRouter(staff: StaffRepository | undefined, writeEnabled = false) {
  const router = Router();

  router.get("/staff", async (request, response, next) => {
    try {
      if (!staff) return response.status(503).json({ error: "staff registry is unavailable", code: "STAFF_UNAVAILABLE" });
      if (!editorAllowed(response.locals.currentUser?.role)) return forbidden(response);
      const q = String(request.query.q ?? "").slice(0, 100);
      const items = await staff.list(q);
      return response.status(200).json({ items });
    } catch (error) { return handle(error, response, next); }
  });

  router.get("/staff/:id", async (request, response, next) => {
    try {
      if (!staff) return response.status(503).json({ error: "staff registry is unavailable", code: "STAFF_UNAVAILABLE" });
      if (!editorAllowed(response.locals.currentUser?.role)) return forbidden(response);
      const { id } = idPath.parse(request.params);
      const record = await staff.find(id);
      if (!record) return response.status(404).json({ error: "指定した担当者が見つかりません", code: "STAFF_NOT_FOUND" });
      return response.status(200).json({ staff: record });
    } catch (error) { return handle(error, response, next); }
  });

  router.post("/staff/validate", (request, response) => {
    const result = staffCreateSchema.safeParse(request.body);
    if (!result.success) {
      return response.status(400).json({
        ok: false, errors: result.error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message }))
      });
    }
    return response.status(200).json({ ok: true });
  });

  router.post("/staff", async (request, response, next) => {
    try {
      if (!writeEnabled || !staff) return unavailable(response);
      if (!editorAllowed(response.locals.currentUser?.role)) return forbidden(response);
      const input = staffCreateSchema.parse(request.body);
      const created = await staff.create(input);
      return response.status(201).json(created);
    } catch (error) { return handle(error, response, next); }
  });

  router.patch("/staff/:id", async (request, response, next) => {
    try {
      if (!writeEnabled || !staff) return unavailable(response);
      if (!editorAllowed(response.locals.currentUser?.role)) return forbidden(response);
      const { id } = idPath.parse(request.params);
      const input = staffUpdateSchema.parse(request.body);
      const updated = await staff.update(id, input);
      return response.status(200).json(updated);
    } catch (error) { return handle(error, response, next); }
  });

  return router;
}
