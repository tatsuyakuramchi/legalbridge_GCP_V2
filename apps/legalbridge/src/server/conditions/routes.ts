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

  router.get("/condition-lines/summary", async (_request, response, next) => {
    try {
      if (!conditions) {
        return response.status(503).json({
          error: "condition line registry is unavailable",
          code: "CONDITION_LINES_UNAVAILABLE"
        });
      }
      const [groups, settlement] = await Promise.all([conditions.summary(), conditions.settlement()]);
      return response.status(200).json({ groups, settlement });
    } catch (error) {
      next(error);
    }
  });

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

  // 重複警告（導線ガード）：ある作品に既に紐づく条件行を返す。
  // /:id より前に登録して literal path を優先させる。
  router.get("/condition-lines/overlap", async (request, response, next) => {
    try {
      if (!conditions) {
        return response.status(503).json({
          error: "condition line registry is unavailable",
          code: "CONDITION_LINES_UNAVAILABLE"
        });
      }
      const { workId } = z.object({ workId: z.coerce.number().int().positive() }).parse(request.query);
      const overlap = await conditions.overlap(workId);
      return response.status(200).json({ overlap });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return response.status(400).json({ error: "invalid request", issues: error.issues });
      }
      next(error);
    }
  });

  // Registered after /condition-lines/summary so the literal path wins.
  router.get("/condition-lines/:id", async (request, response, next) => {
    try {
      if (!conditions) {
        return response.status(503).json({
          error: "condition line registry is unavailable",
          code: "CONDITION_LINES_UNAVAILABLE"
        });
      }
      const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
      const detail = await conditions.find(id);
      if (!detail) {
        return response.status(404).json({ error: "condition line not found", code: "CONDITION_LINE_NOT_FOUND" });
      }
      return response.status(200).json({ detail });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return response.status(400).json({ error: "invalid request", issues: error.issues });
      }
      next(error);
    }
  });

  return router;
}
