import { Router } from "express";
import { z } from "zod";
import { RequestWriteError, type RequestRepository } from "./repository.js";

const idSchema = z.object({ id: z.coerce.number().int().positive() });
const linkSchema = z.object({
  matterId: z.coerce.number().int().positive(),
  primary: z.boolean().optional().default(false)
});

export function createRequestRouter(
  repository: RequestRepository,
  linkWriteEnabled = false
) {
  const router = Router();

  router.get("/requests", async (request, response, next) => {
    try {
      const query = String(request.query.q ?? "").slice(0, 100);
      const limit = Number.parseInt(String(request.query.limit ?? "200"), 10) || 200;
      return response.json({ requests: await repository.list(query, limit) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/requests/:id", async (request, response, next) => {
    try {
      const { id } = idSchema.parse(request.params);
      const detail = await repository.find(id);
      if (!detail) return response.status(404).json({ error: "request not found" });
      return response.json(detail);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return response.status(400).json({ error: "invalid request id", issues: error.issues });
      }
      next(error);
    }
  });

  router.post("/requests/:id/link-matter", async (request, response, next) => {
    try {
      if (!linkWriteEnabled) {
        return response.status(503).json({
          error: "request to matter linking is not enabled",
          code: "REQUEST_LINK_WRITE_UNAVAILABLE"
        });
      }
      const role = response.locals.currentUser?.role;
      if (role !== "admin" && role !== "legal") {
        return response.status(403).json({
          error: "法務または管理者のみが案件へ紐付けできます",
          code: "REQUEST_LINK_FORBIDDEN"
        });
      }
      const { id } = idSchema.parse(request.params);
      const input = linkSchema.parse(request.body);
      return response.status(200).json(
        await repository.linkMatter(id, input.matterId, input.primary)
      );
    } catch (error) {
      if (error instanceof RequestWriteError) {
        const status = error.code === "REQUEST_NOT_FOUND" || error.code === "MATTER_NOT_FOUND" ? 404 : 422;
        return response.status(status).json({ error: error.message, code: error.code });
      }
      if (error instanceof z.ZodError) {
        return response.status(400).json({ error: "invalid request", issues: error.issues });
      }
      next(error);
    }
  });

  return router;
}
