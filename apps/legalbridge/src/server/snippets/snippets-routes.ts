import { Router } from "express";
import { z } from "zod";
import {
  snippetSaveSchema, SnippetError, type SnippetsRepository
} from "./snippets-repository.js";

// スニペット（Phase 16-1）。読取＝認証済み全ロール（文書作成の定型文言のため requester も対象）。
// 保存・無効化＝guarded（既定 OFF・admin/legal・scope 'snippets'・grant 045）。

function canEdit(role: string | undefined) { return role === "admin" || role === "legal"; }
function forbidden(r: import("express").Response) {
  return r.status(403).json({ error: "管理者または法務のみがスニペットを編集できます", code: "SNIPPETS_FORBIDDEN" });
}
function handleError(error: unknown, response: import("express").Response): boolean {
  if ((error as { code?: string })?.code === "42501") {
    response.status(503).json({ error: "スニペット書込の権限が付与されていません", code: "SNIPPETS_FORBIDDEN_DB" });
    return true;
  }
  if (error instanceof SnippetError) {
    response.status(404).json({ error: error.message, code: error.code });
    return true;
  }
  return false;
}

export function createSnippetsRouter(repository: SnippetsRepository | undefined, writeEnabled = false) {
  const router = Router();

  router.get("/snippets", async (_request, response, next) => {
    try {
      if (!repository) return response.status(503).json({ error: "snippets is not available", code: "SNIPPETS_UNAVAILABLE" });
      const snippets = await repository.list();
      return response.status(200).json({ snippets, writeEnabled });
    } catch (error) { return next(error); }
  });

  router.post("/snippets", async (request, response, next) => {
    try {
      if (!writeEnabled || !repository) {
        return response.status(503).json({ error: "snippets write is not enabled", code: "SNIPPETS_WRITE_UNAVAILABLE" });
      }
      if (!canEdit(response.locals.currentUser?.role)) return forbidden(response);
      const input = snippetSaveSchema.parse(request.body ?? {});
      try {
        const saved = await repository.save(input);
        return response.status(200).json(saved);
      } catch (error) {
        if (handleError(error, response)) return;
        throw error;
      }
    } catch (error) {
      if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
      return next(error);
    }
  });

  router.post("/snippets/:id/deactivate", async (request, response, next) => {
    try {
      if (!writeEnabled || !repository) {
        return response.status(503).json({ error: "snippets write is not enabled", code: "SNIPPETS_WRITE_UNAVAILABLE" });
      }
      if (!canEdit(response.locals.currentUser?.role)) return forbidden(response);
      const id = Number(request.params.id);
      if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: "invalid snippet id" });
      try {
        await repository.deactivate(id);
        return response.status(200).json({ ok: true });
      } catch (error) {
        if (handleError(error, response)) return;
        throw error;
      }
    } catch (error) { return next(error); }
  });

  return router;
}
