import { Router } from "express";
import { z } from "zod";
import type { ReceiptDashboardRepository } from "./receipt-dashboard-repository.js";

// 請求ダッシュボード（読み取り）。金銭データのため admin/legal 限定。
// 書込みは行わないため write ゲートは不要（GET）。

const querySchema = z.object({
  q: z.string().trim().max(200).optional(),
  period: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  unreceived: z.coerce.boolean().optional(),
  undistributed: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional()
});

export function createReceiptDashboardRouter(repository?: ReceiptDashboardRepository) {
  const router = Router();

  router.get("/receipts-dashboard", async (request, response, next) => {
    try {
      const role = response.locals.currentUser?.role;
      if (role !== "admin" && role !== "legal") {
        return response.status(403).json({ error: "legal or administrator access is required", code: "RECEIPTS_DASHBOARD_ROLE_REQUIRED" });
      }
      if (!repository) {
        return response.status(200).json({ rows: [], summary: { totalReceiptRoyalty: 0, totalReceived: 0, totalDistribution: 0, count: 0, truncated: false } });
      }
      const query = querySchema.parse(request.query);
      const result = await repository.list(query);
      return response.status(200).json(result);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return response.status(400).json({ error: "invalid request", issues: error.issues });
      }
      next(error);
    }
  });

  return router;
}
