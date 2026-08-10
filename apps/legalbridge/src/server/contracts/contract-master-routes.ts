import { Router } from "express";
import { z } from "zod";
import { contractUpdateSchema, contractStatusSchema } from "./contract-master-schema.js";
import { ContractMasterError, type ContractMasterRepository } from "./contract-master-repository.js";

// 契約マスタ（Phase 11-4）。読取（admin/legal）＋更新・状態変更（guarded-write・既定OFF・admin/legal）。
// 登録(INSERT)は contract-intake が担う。ここは既存 contracts 行の中核フィールド更新と状態変更のみ。
function canEdit(role: string | undefined) { return role === "admin" || role === "legal"; }
function forbidden(r: import("express").Response) {
  return r.status(403).json({ error: "管理者または法務のみが契約マスタを編集できます", code: "CONTRACT_MASTER_FORBIDDEN" });
}
function handleDbError(error: unknown, response: import("express").Response): boolean {
  if ((error as { code?: string })?.code === "42501") {
    response.status(503).json({ error: "契約マスタ書込の権限が付与されていません", code: "CONTRACT_MASTER_FORBIDDEN_DB" });
    return true;
  }
  if (error instanceof ContractMasterError) {
    const status = error.code === "CONTRACT_NOT_FOUND" ? 404 : 400;
    response.status(status).json({ error: error.message, code: error.code });
    return true;
  }
  return false;
}

export function createContractMasterRouter(
  repository: ContractMasterRepository | undefined,
  writeEnabled = false
) {
  const router = Router();

  router.get("/contracts", async (request, response, next) => {
    try {
      if (!repository) return response.status(503).json({ error: "contract master is not available", code: "CONTRACT_MASTER_UNAVAILABLE" });
      if (!canEdit(response.locals.currentUser?.role)) return forbidden(response);
      const query = typeof request.query.q === "string" ? request.query.q : "";
      const contracts = await repository.list(query);
      return response.status(200).json({ contracts, writeEnabled });
    } catch (error) { return next(error); }
  });

  router.patch("/contracts/:id", async (request, response, next) => {
    try {
      if (!writeEnabled || !repository) {
        return response.status(503).json({ error: "contract master write is not enabled", code: "CONTRACT_MASTER_WRITE_UNAVAILABLE" });
      }
      if (!canEdit(response.locals.currentUser?.role)) return forbidden(response);
      const id = Number(request.params.id);
      if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: "invalid contract id" });
      const input = contractUpdateSchema.parse(request.body ?? {});
      try {
        const contract = await repository.update(id, input);
        return response.status(200).json({ contract });
      } catch (error) {
        if (handleDbError(error, response)) return;
        throw error;
      }
    } catch (error) {
      if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
      return next(error);
    }
  });

  router.patch("/contracts/:id/status", async (request, response, next) => {
    try {
      if (!writeEnabled || !repository) {
        return response.status(503).json({ error: "contract master write is not enabled", code: "CONTRACT_MASTER_WRITE_UNAVAILABLE" });
      }
      if (!canEdit(response.locals.currentUser?.role)) return forbidden(response);
      const id = Number(request.params.id);
      if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: "invalid contract id" });
      const input = contractStatusSchema.parse(request.body ?? {});
      try {
        const contract = await repository.setStatus(id, input);
        return response.status(200).json({ contract });
      } catch (error) {
        if (handleDbError(error, response)) return;
        throw error;
      }
    } catch (error) {
      if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
      return next(error);
    }
  });

  return router;
}
