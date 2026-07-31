import { Router } from "express";
import type { GlobalSearchRepository } from "./repository.js";
export function createGlobalSearchRouter(repository: GlobalSearchRepository) {
  const router = Router();
  router.get("/search", async (request, response, next) => {
    try {
      const query = String(request.query.q ?? "").trim().slice(0, 100);
      if (query.length < 2) return response.json({ query, results: [] });
      response.json({ query, results: await repository.search(query) });
    } catch (error) { next(error); }
  });
  return router;
}
