import { Router } from "express";
import { z } from "zod";
import type { PaymentReportRepository } from "./payment-report-repository.js";

// 支払報告書（読み取り・admin/legal限定）。書込みなし。
export function createPaymentReportRouter(repository?: PaymentReportRepository) {
  const router = Router();

  router.get("/payment-report", async (request, response, next) => {
    try {
      const role = response.locals.currentUser?.role;
      if (role !== "admin" && role !== "legal") {
        return response.status(403).json({ error: "legal or administrator access is required", code: "PAYMENT_REPORT_ROLE_REQUIRED" });
      }
      const { period } = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/).optional() }).parse(request.query);
      const report = repository
        ? await repository.list(period)
        : { lines: [], totals: { subtotalExTax: 0, consumptionTax: 0, withholdingTax: 0, netTransfer: 0, count: 0 } };
      return response.status(200).json(report);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return response.status(400).json({ error: "invalid request", issues: error.issues });
      }
      next(error);
    }
  });

  return router;
}
