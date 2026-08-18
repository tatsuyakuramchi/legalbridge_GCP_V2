import { Router } from "express";
import { z } from "zod";
import type { WorkReadRepository } from "./read-repository.js";

// 作品集約リード（Phase 2・読み取り専用・admin/legal限定）。書込みなし。
//   GET /works            … 作品一覧/検索（ピッカー・横断検索用）。
//   GET /works/:id/detail … 作品を起点に 概要/系譜/素材/権利ソース/条件 を集約。
// 既存の書込みルーター（GET /works/:id 等）とパスが衝突しないよう、
// 一覧は /works、詳細は /works/:id/detail に分離する。
export function createWorkReadRouter(repository?: WorkReadRepository) {
  const router = Router();

  const requireLegal = (response: import("express").Response): boolean => {
    const role = response.locals.currentUser?.role;
    if (role !== "admin" && role !== "legal") {
      response.status(403).json({ error: "legal or administrator access is required", code: "WORK_READ_ROLE_REQUIRED" });
      return false;
    }
    return true;
  };

  router.get("/works", async (request, response, next) => {
    try {
      if (!requireLegal(response)) return;
      const query = z.object({
        keyword: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional()
      }).parse(request.query);
      const result = repository
        ? await repository.list(query)
        : { works: [], total: 0 };
      return response.status(200).json(result);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return response.status(400).json({ error: "invalid request", issues: error.issues });
      }
      next(error);
    }
  });

  // ライセンスマトリクス（R4・横断読取）。/works/:id より先に定義（:id に食われないように）。
  router.get("/works/rights-matrix", async (_request, response, next) => {
    try {
      if (!requireLegal(response)) return;
      const lines = repository?.rightsMatrixLines
        ? await repository.rightsMatrixLines()
        : [];
      return response.status(200).json({ lines });
    } catch (error) {
      return next(error);
    }
  });

  router.get("/works/:id/detail", async (request, response, next) => {
    try {
      if (!requireLegal(response)) return;
      const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
      const detail = repository ? await repository.detail(id) : null;
      if (!detail) {
        return response.status(404).json({ error: "work not found", code: "WORK_NOT_FOUND" });
      }
      return response.status(200).json(detail);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return response.status(400).json({ error: "invalid request", issues: error.issues });
      }
      next(error);
    }
  });

  return router;
}
