import { Router } from "express";
import type { AdminRepository } from "./repository.js";
import { slackUxPreviewCatalog } from "../integrations/slack-ux.js";
import { buildSlackNotificationCandidates } from "../integrations/slack-candidates.js";
import { evaluateSlackCandidates } from "../integrations/slack-deduplication.js";
import type { MatterRepository } from "../matters/repository.js";
import type { SlackNotificationHistoryRepository } from "../integrations/slack-history-repository.js";
import { buildSlackDryRunQueue } from "../integrations/slack-dry-run.js";
export function createAdminRouter(
  repository: AdminRepository,
  matters?: MatterRepository,
  history?: SlackNotificationHistoryRepository,
  slackDryRunChannelId?: string
) {
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
      let historyRecords: Awaited<ReturnType<SlackNotificationHistoryRepository["list"]>> | null = null;
      let historyStatus: "disabled" | "connected" | "unavailable" = "disabled";
      if (history) {
        try {
          historyRecords = await history.list(rawCandidates.map((item) => item.issueKey));
          historyStatus = "connected";
        } catch (error) {
          historyStatus = "unavailable";
          console.error("Slack notification history lookup failed", {
            name: error instanceof Error ? error.name : "UnknownError"
          });
        }
      }
      const candidates = evaluateSlackCandidates(rawCandidates, historyRecords);
      const dryRunQueue = buildSlackDryRunQueue(candidates, slackDryRunChannelId);
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
          withoutPrimaryIssue: sourceMatters.filter((item) => !item.primaryIssueKey).length,
          dryRunReviewable: dryRunQueue.filter((item) => item.readiness === "ready_for_review").length,
          dryRunBlocked: dryRunQueue.filter((item) => item.readiness.startsWith("blocked_")).length,
          dryRunSuppressed: dryRunQueue.filter((item) => item.readiness.startsWith("suppressed_")).length
        },
        history: {
          configured: Boolean(history),
          connected: historyStatus === "connected",
          status: historyStatus,
          externalSend: false
        },
        candidates,
        dryRun: {
          mode: "dry-run",
          externalSend: false,
          historyAppend: false,
          destinationConfigured: dryRunQueue.some((item) => item.target.resolution === "configured"),
          queue: dryRunQueue
        }
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
