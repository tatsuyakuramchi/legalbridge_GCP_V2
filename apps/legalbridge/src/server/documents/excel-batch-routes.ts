import { Router } from "express";
import { z } from "zod";
import type { ExcelBatchRepository } from "./excel-batch-repository.js";
import { groupExcelBatches } from "./excel-batch-engine.js";

// Excel 一括出力（Phase 10-5）。集計は読取（admin/legal）。発行済みマークは guarded-write
// （capability 'excel-batch'・隔離台帳 grant 035・確認トークン不要＝本番業務表は不変）。
// 帳票（Excel ファイル）自体は client の export-util で生成する（サーバは対象データと集計のみ）。

function editorAllowed(role: string | undefined) { return role === "admin" || role === "legal"; }
function forbidden(r: import("express").Response) {
  return r.status(403).json({ error: "法務または管理者のみが利用できます", code: "EXCEL_BATCH_FORBIDDEN" });
}

const markSchema = z.object({
  documentNumbers: z.array(z.string().trim().min(1).max(120)).min(1).max(1000),
  batchKey: z.string().trim().max(200).optional()
});

export function createExcelBatchRouter(
  repository: ExcelBatchRepository | undefined,
  writeEnabled = false
) {
  const router = Router();

  // 未発行の検収書/利用許諾料計算書を 種別×担当者×支払期日 で集計。
  router.get("/documents/excel-batches", async (request, response, next) => {
    try {
      if (!repository) return response.status(503).json({ error: "excel batch is not available", code: "EXCEL_BATCH_UNAVAILABLE" });
      if (!editorAllowed(response.locals.currentUser?.role)) return forbidden(response);
      const limit = Number.parseInt(String(request.query.limit ?? "1000"), 10);
      const docs = await repository.loadPending(Number.isFinite(limit) ? limit : 1000);
      const groups = groupExcelBatches(docs);
      return response.status(200).json({ groups, total: docs.length, writeEnabled });
    } catch (error) { return next(error); }
  });

  // 選択文書を発行済みとして記録（保留一覧から除外）。
  router.post("/documents/excel-batches/mark", async (request, response, next) => {
    try {
      if (!writeEnabled || !repository) {
        return response.status(503).json({ error: "excel batch mark is not enabled", code: "EXCEL_BATCH_WRITE_UNAVAILABLE" });
      }
      if (!editorAllowed(response.locals.currentUser?.role)) return forbidden(response);
      const input = markSchema.parse(request.body ?? {});
      const actor = String(response.locals.currentUser?.email ?? "unknown");
      try {
        const recorded = await repository.markExported(input.documentNumbers, input.batchKey ?? "", actor);
        return response.status(200).json({ recorded, requested: input.documentNumbers.length });
      } catch (error) {
        if ((error as { code?: string })?.code === "42501") {
          return response.status(503).json({ error: "Excel 発行台帳の権限が付与されていません", code: "EXCEL_BATCH_FORBIDDEN_DB" });
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
      return next(error);
    }
  });

  return router;
}
