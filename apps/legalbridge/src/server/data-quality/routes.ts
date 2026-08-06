import { Router } from "express";
import type { DataQualityRepository } from "./repository.js";

// データ品質センター（読み取り・admin/legal限定）。書込みなし。
export function createDataQualityRouter(repository?: DataQualityRepository) {
  const router = Router();

  router.get("/data-quality", async (_request, response, next) => {
    try {
      const role = response.locals.currentUser?.role;
      if (role !== "admin" && role !== "legal") {
        return response.status(403).json({ error: "legal or administrator access is required", code: "DATA_QUALITY_ROLE_REQUIRED" });
      }
      const report = repository ? await repository.scan() : null;
      if (!report) {
        return response.status(200).json({ categories: [], summary: { totalIssues: 0, highIssues: 0, categoriesWithIssues: 0, scannedCategories: 0, unavailableCategories: 0 } });
      }
      return response.status(200).json(report);
    } catch (error) { next(error); }
  });

  return router;
}
