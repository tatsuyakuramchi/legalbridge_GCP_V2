import { Router } from "express";
import { z } from "zod";
import { workflowRuleSchema } from "./workflow-rules-schema.js";
import type { WorkflowRulesRepository } from "./workflow-rules-repository.js";

// 承認ルート（Phase 11-2）。読取（admin）＋upsert（guarded-write・既定OFF・admin・department 一意）。
function adminOnly(role: string | undefined) { return role === "admin"; }
function forbidden(r: import("express").Response) {
  return r.status(403).json({ error: "管理者のみが承認ルートを編集できます", code: "WORKFLOW_RULES_FORBIDDEN" });
}

export function createWorkflowRulesRouter(
  repository: WorkflowRulesRepository | undefined,
  writeEnabled = false
) {
  const router = Router();

  router.get("/workflow-rules", async (request, response, next) => {
    try {
      if (!repository) return response.status(503).json({ error: "workflow rules is not available", code: "WORKFLOW_RULES_UNAVAILABLE" });
      if (!adminOnly(response.locals.currentUser?.role)) return forbidden(response);
      const rules = await repository.list();
      return response.status(200).json({ rules, writeEnabled });
    } catch (error) { return next(error); }
  });

  router.post("/workflow-rules", async (request, response, next) => {
    try {
      if (!writeEnabled || !repository) {
        return response.status(503).json({ error: "workflow rules write is not enabled", code: "WORKFLOW_RULES_WRITE_UNAVAILABLE" });
      }
      if (!adminOnly(response.locals.currentUser?.role)) return forbidden(response);
      const input = workflowRuleSchema.parse(request.body ?? {});
      try {
        const rule = await repository.upsert(input);
        return response.status(200).json({ rule });
      } catch (error) {
        if ((error as { code?: string })?.code === "42501") {
          return response.status(503).json({ error: "承認ルート書込の権限が付与されていません", code: "WORKFLOW_RULES_FORBIDDEN_DB" });
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
