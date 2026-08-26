import { Router } from "express";
import { z } from "zod";
import type { DocumentRegistryRepository } from "./registry-repository.js";
import { buildDocumentConditionInputs, hasConditionSyncData } from "./condition-sync.js";
import type { ConditionSyncRepository } from "./condition-sync-repository.js";

// 条件明細（condition_lines）の手動同期。
//   - 確定時の自動同期が失敗した文書のリカバリ
//   - grant 066 適用前に確定した既存文書のバックフィル
// form_data の金銭条件・v3マトリクスから台帳を作り直す（置換 upsert・実績あり行は保全）。
// admin/legal のみ。冪等＝何度実行しても同じ結果になる。

const idPath = z.object({ id: z.coerce.number().int().positive() });

export function createConditionSyncRouter(dependencies: {
  registry?: DocumentRegistryRepository;
  conditionSync?: ConditionSyncRepository;
  writeEnabled?: boolean;
}) {
  const { registry, conditionSync } = dependencies;
  const writeEnabled = dependencies.writeEnabled === true;
  const router = Router();

  router.post("/documents/:id/conditions/sync", async (request, response, next) => {
    try {
      if (!writeEnabled || !registry || !conditionSync) {
        return response.status(503).json({
          error: "condition sync is not enabled", code: "CONDITION_SYNC_UNAVAILABLE"
        });
      }
      const role = response.locals.currentUser?.role;
      if (role !== "admin" && role !== "legal") {
        return response.status(403).json({ error: "法務または管理者のみが同期できます", code: "CONDITION_SYNC_FORBIDDEN" });
      }
      const { id } = idPath.parse(request.params);
      const document = await registry.find(id);
      if (!document) {
        return response.status(404).json({ error: "文書が見つかりません", code: "DOCUMENT_NOT_FOUND" });
      }
      if (document.lifecycleStatus === "voided") {
        return response.status(409).json({
          error: "無効化された文書の条件は同期できません", code: "CONDITION_SYNC_VOIDED"
        });
      }
      const formData = document.formData ?? {};
      if (!hasConditionSyncData(formData)) {
        return response.status(422).json({
          error: "この文書には同期できる条件データ（金銭条件・v3マトリクス）がありません",
          code: "CONDITION_SYNC_NO_DATA"
        });
      }
      try {
        const result = await conditionSync.upsertDocumentConditions(
          id, buildDocumentConditionInputs(formData)
        );
        return response.status(200).json({ written: result.written, deleted: result.deleted });
      } catch (error) {
        if ((error as { code?: string })?.code === "42501") {
          return response.status(503).json({
            error: "条件明細の台帳同期権限が付与されていません（grant 066 を適用してください）",
            code: "CONDITION_SYNC_FORBIDDEN_DB"
          });
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
