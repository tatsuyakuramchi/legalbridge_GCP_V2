import { Router } from "express";
import { z } from "zod";
import type { PendingInspectionRepository } from "./repository.js";

const querySchema = z.object({
  q: z.string().optional().default(""),
  pending: z.enum(["0", "1"]).optional().default("1"),
  limit: z.coerce.number().int().positive().max(1000).optional().default(300)
});

// Read-only 発注書 worklist (検収待ち, document-level).
export function createPendingInspectionRouter(inspections: PendingInspectionRepository | undefined) {
  const router = Router();

  router.get("/pending-inspections", async (request, response, next) => {
    try {
      if (!inspections) {
        return response.status(503).json({
          error: "inspection worklist is unavailable",
          code: "PENDING_INSPECTIONS_UNAVAILABLE"
        });
      }
      const { q, pending, limit } = querySchema.parse(request.query);
      const items = await inspections.list(q, pending === "1", limit);
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
