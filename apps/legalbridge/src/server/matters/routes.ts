import { Router } from "express";
import type { MatterRepository } from "./repository.js";

const statuses = new Set(["open", "in_progress", "closed", "archived"]);
export function createMatterRouter(repository: MatterRepository) {
  const router = Router();
  router.get("/matters", async (request, response, next) => {
    try {
      const query = String(request.query.q ?? "").slice(0, 100);
      const status = String(request.query.status ?? "");
      if (status && !statuses.has(status)) return response.status(400).json({ error: "invalid matter status" });
      const limit = Number.parseInt(String(request.query.limit ?? "200"), 10) || 200;
      response.json({ matters: await repository.list(query, status || undefined, limit) });
    } catch (error) { next(error); }
  });
  router.get("/matters/:id", async (request, response, next) => {
    try {
      const id = Number.parseInt(request.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: "invalid matter id" });
      const detail = await repository.find(id);
      if (!detail) return response.status(404).json({ error: "matter not found" });
      response.json(detail);
    } catch (error) { next(error); }
  });
  return router;
}
