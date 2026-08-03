import { Router } from "express";
import { z } from "zod";
import type { ConditionLineRepository } from "./repository.js";

const querySchema = z.object({
  q: z.string().optional().default(""),
  limit: z.coerce.number().int().positive().max(1000).optional().default(300)
});

// Read-only cross-cutting condition-lines list (条件明細 横断検索).
export function createConditionLineRouter(conditions: ConditionLineRepository | undefined) {
  const router = Router();

  router.get("/condition-lines", async (request, response, next) => {
    try {
      if (!conditions) {
        return response.status(503).json({
          error: "condition line registry is unavailable",
          code: "CONDITION_LINES_UNAVAILABLE"
        });
      }
      const { q, limit } = querySchema.parse(request.query);
      const items = await conditions.list(q, limit);
      return response.status(200).json({ items });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return response.status(400).json({ error: "invalid request", issues: error.issues });
      }
      next(error);
    }
  });

  return router;
}
