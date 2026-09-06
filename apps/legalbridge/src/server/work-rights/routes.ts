import { Router } from "express";
import { z } from "zod";
import type { WorkRightsRepository } from "./repository.js";

export function createWorkRightsRouter(repository: WorkRightsRepository) {
  const router = Router();

  router.get("/work-rights", async (request, response, next) => {
    try {
      const query = String(request.query.q ?? "").slice(0, 100);
      const limit = Number.parseInt(String(request.query.limit ?? "200"), 10) || 200;
      return response.json({ works: await repository.list(query, limit) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/work-rights/:id", async (request, response, next) => {
    try {
      const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
      const detail = await repository.find(id);
      if (!detail) return response.status(404).json({ error: "work not found" });
      return response.json(detail);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return response.status(400).json({ error: "invalid work id", issues: error.issues });
      }
      next(error);
    }
  });

  return router;
}
