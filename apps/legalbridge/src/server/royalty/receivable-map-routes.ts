import { Router } from "express";
import { z } from "zod";
import type { ReceivableMapRepository } from "./receivable-map-repository.js";

// 債権マップ（読み取り・admin/legal限定）。書込みなし。
export function createReceivableMapRouter(repository?: ReceivableMapRepository) {
  const router = Router();

  router.get("/receivable-map", async (request, response, next) => {
    try {
      const role = response.locals.currentUser?.role;
      if (role !== "admin" && role !== "legal") {
        return response.status(403).json({ error: "legal or administrator access is required", code: "RECEIVABLE_MAP_ROLE_REQUIRED" });
      }
      const { workId } = z.object({ workId: z.coerce.number().int().positive() }).parse(request.query);
      const map = repository ? await repository.forWork(workId) : null;
      if (!map) {
        return response.status(404).json({ error: "no receivable map for this work", code: "RECEIVABLE_MAP_NOT_FOUND" });
      }
      return response.status(200).json({ map });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return response.status(400).json({ error: "invalid request", issues: error.issues });
      }
      next(error);
    }
  });

  return router;
}
