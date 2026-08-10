import { Router } from "express";
import { z } from "zod";
import type { DocumentRegistryRepository } from "./registry-repository.js";
import type { DocumentLookupRepository } from "./document-lookup-repository.js";

// 文書ルックアップ（読取専用・Phase 10-6）。番号検索・PDF未生成一覧・次番号プレビュー。
// いずれも読取＝認証済みユーザーが利用可（ロール限定なし・新規 GRANT/フラグなし）。
// 注意：/documents/pending-pdf 等は /documents/:id より前に評価される必要があるため、
//       app.ts では registry ルーターより前にマウントする。

export function createDocumentLookupRouter(
  registry: DocumentRegistryRepository,
  lookup: DocumentLookupRepository
) {
  const router = Router();

  // PDF 未生成（Drive 未保存・void でない）の一覧＋種別別件数。
  router.get("/documents/pending-pdf", async (request, response, next) => {
    try {
      const templateType = String(request.query.template_type ?? "").trim() || undefined;
      const limit = Number.parseInt(String(request.query.limit ?? "100"), 10);
      const result = await lookup.pendingPdf(templateType, Number.isFinite(limit) ? limit : 100);
      return response.status(200).json(result);
    } catch (error) { return next(error); }
  });

  // 次番号プレビュー（非破壊・sequences は増分しない）。?type=purchase_order
  router.get("/documents/numbering/next", async (request, response, next) => {
    try {
      const templateType = String(request.query.type ?? request.query.template_type ?? "").trim();
      if (!templateType) return response.status(400).json({ error: "type is required", code: "NUMBERING_TYPE_REQUIRED" });
      const preview = await lookup.peekNextNumber(templateType);
      if (!preview) return response.status(404).json({ error: "採番プレフィックスが未設定です", code: "NUMBERING_PREFIX_MISSING" });
      return response.status(200).json(preview);
    } catch (error) { return next(error); }
  });

  // 文書番号から1件を引く（アーカイブ再編集導線・番号検索）。
  const numberPath = z.object({ docNumber: z.string().trim().min(1).max(120) });
  router.get("/documents/by-number/:docNumber", async (request, response, next) => {
    try {
      const { docNumber } = numberPath.parse(request.params);
      const document = await registry.findByNumber(docNumber);
      if (!document) return response.status(404).json({ error: "document not found", code: "DOCUMENT_NOT_FOUND" });
      return response.status(200).json({ document });
    } catch (error) {
      if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
      return next(error);
    }
  });

  return router;
}
