import { Router } from "express";
import { z } from "zod";
import type { DeadlineRepository } from "./repository.js";

const querySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
});

export function createDeadlineRouter(repository: DeadlineRepository) {
  const router = Router();
  router.get("/deadline-events", async (request,response,next) => {
    try {
      const { from, to } = querySchema.parse(request.query);
      if (from > to) return response.status(400).json({ error: "from must be before to" });
      return response.json({ events: await repository.list(from,to) });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return response.status(400).json({ error: "from/to are required as YYYY-MM-DD", issues:error.issues });
      }
      next(error);
    }
  });
  return router;
}
