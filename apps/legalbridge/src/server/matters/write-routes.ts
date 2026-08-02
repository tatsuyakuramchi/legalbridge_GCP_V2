import { Router } from "express";
import { z } from "zod";
import {
  matterCreateSchema, matterUpdateSchema, taskCreateSchema, taskUpdateSchema
} from "./write-schema.js";
import { MatterWriteError, type MatterWriteRepository } from "./write-repository.js";

const matterPath = z.object({ id: z.coerce.number().int().positive() });
const taskPath = z.object({
  id: z.coerce.number().int().positive(),
  taskId: z.coerce.number().int().positive()
});

function editorAllowed(role: string | undefined) {
  return role === "admin" || role === "legal";
}
function unavailable(response: import("express").Response) {
  return response.status(503).json({
    error: "matter editing is not enabled",
    code: "MATTER_WRITE_UNAVAILABLE"
  });
}
function forbidden(response: import("express").Response) {
  return response.status(403).json({
    error: "法務または管理者のみが案件を編集できます",
    code: "MATTER_EDIT_FORBIDDEN"
  });
}
function statusFor(code: string) {
  if (code === "MATTER_NOT_FOUND" || code === "MATTER_TASK_NOT_FOUND") return 404;
  if (code === "MATTER_REFERENCE_INVALID") return 422;
  if (code === "MATTER_CONFLICT") return 409;
  if (code === "MATTER_CHECK_FAILED") return 422;
  return 400;
}

export function createMatterWriteRouter(
  matters: MatterWriteRepository | undefined,
  writeEnabled = false
) {
  const router = Router();

  router.post("/matters/validate", (request, response) => {
    const result = matterCreateSchema.safeParse(request.body);
    if (!result.success) {
      return response.status(400).json({
        ok: false,
        errors: result.error.issues.map((issue) => ({
          field: issue.path.join("."), message: issue.message
        }))
      });
    }
    return response.status(200).json({ ok: true });
  });

  router.post("/matters", async (request, response, next) => {
    try {
      if (!writeEnabled || !matters) return unavailable(response);
      if (!editorAllowed(response.locals.currentUser?.role)) return forbidden(response);
      const input = matterCreateSchema.parse(request.body);
      const created = await matters.createMatter(input, response.locals.currentUser!.email);
      return response.status(201).json(created);
    } catch (error) {
      return handleError(error, response, next);
    }
  });

  router.patch("/matters/:id", async (request, response, next) => {
    try {
      if (!writeEnabled || !matters) return unavailable(response);
      if (!editorAllowed(response.locals.currentUser?.role)) return forbidden(response);
      const { id } = matterPath.parse(request.params);
      const input = matterUpdateSchema.parse(request.body);
      const updated = await matters.updateMatter(id, input, response.locals.currentUser!.email);
      return response.status(200).json(updated);
    } catch (error) {
      return handleError(error, response, next);
    }
  });

  router.post("/matters/:id/tasks", async (request, response, next) => {
    try {
      if (!writeEnabled || !matters) return unavailable(response);
      if (!editorAllowed(response.locals.currentUser?.role)) return forbidden(response);
      const { id } = matterPath.parse(request.params);
      const input = taskCreateSchema.parse(request.body);
      const created = await matters.createTask(id, input, response.locals.currentUser!.email);
      return response.status(201).json(created);
    } catch (error) {
      return handleError(error, response, next);
    }
  });

  router.patch("/matters/:id/tasks/:taskId", async (request, response, next) => {
    try {
      if (!writeEnabled || !matters) return unavailable(response);
      if (!editorAllowed(response.locals.currentUser?.role)) return forbidden(response);
      const { id, taskId } = taskPath.parse(request.params);
      const input = taskUpdateSchema.parse(request.body);
      const updated = await matters.updateTask(id, taskId, input);
      return response.status(200).json(updated);
    } catch (error) {
      return handleError(error, response, next);
    }
  });

  return router;
}

function handleError(
  error: unknown,
  response: import("express").Response,
  next: import("express").NextFunction
) {
  if (error instanceof MatterWriteError) {
    return response.status(statusFor(error.code)).json({ error: error.message, code: error.code });
  }
  if (error instanceof z.ZodError) {
    return response.status(400).json({ error: "invalid request", issues: error.issues });
  }
  return next(error);
}
