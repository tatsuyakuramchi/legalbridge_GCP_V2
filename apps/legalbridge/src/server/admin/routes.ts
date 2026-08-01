import { Router } from "express";
import type { AdminRepository } from "./repository.js";
import { slackUxPreviewCatalog } from "../integrations/slack-ux.js";
import { buildSlackNotificationCandidates } from "../integrations/slack-candidates.js";
import { evaluateSlackCandidates } from "../integrations/slack-deduplication.js";
import type { MatterRepository } from "../matters/repository.js";
export function createAdminRouter(repository: AdminRepository, matters?: MatterRepository) {
  const router = Router();
  router.get("/admin/overview", async (_request, response, next) => {
    try { response.json(await repository.overview()); }
    catch (error) { next(error); }
  });
  router.get("/admin/slack-notification-candidates", async (request, response, next) => {
    try {
      const sourceMatters = matters ? await matters.list("", undefined, 200) : [];
      const baseUrl = `${request.protocol}://${request.get("host")}`;
      const rawCandidates = buildSlackNotificationCandidates(sourceMatters, baseUrl);
      const candidates = evaluateSlackCandidates(rawCandidates, null);
      response.json({
        mode: "preview",
        externalSend: false,
        source: "matter_overview_v",
        generatedAt: new Date().toISOString(),
        summary: {
          matters: sourceMatters.length,
          candidates: candidates.filter((item) => item.notification.shouldNotify).length,
          ready: candidates.filter((item) => item.eligibility === "ready").length,
          duplicates: candidates.filter((item) => item.eligibility === "duplicate").length,
          historyUnavailable: candidates.filter((item) => item.eligibility === "history_unavailable").length,
          quiet: candidates.filter((item) => item.eligibility === "quiet").length,
          withoutPrimaryIssue: sourceMatters.filter((item) => !item.primaryIssueKey).length
        },
        history: { connected: false, externalSend: false },
        candidates
      });
    } catch (error) { next(error); }
  });
  router.get("/admin/slack-ux-preview", (_request, response) => {
    response.json({
      mode: "preview",
      externalSend: false,
      principles: [
        "Slackは申請入口と行動が必要な通知に限定する",
        "案件ごとに一つのスレッドへ集約する",
        "内部工程を利用者向けの七段階へ変換する",
        "通知には現在地と次の行動を必ず表示する"
      ],
      notifications: slackUxPreviewCatalog()
    });
  });
  return router;
}
