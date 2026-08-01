import { Router } from "express";
import type { AdminRepository } from "./repository.js";
import { slackUxPreviewCatalog } from "../integrations/slack-ux.js";
import { buildSlackNotificationCandidates } from "../integrations/slack-candidates.js";
import { evaluateSlackCandidates } from "../integrations/slack-deduplication.js";
import type { MatterRepository } from "../matters/repository.js";
import type { SlackNotificationHistoryRepository } from "../integrations/slack-history-repository.js";
import type { SlackNotificationApprovalRepository } from "../integrations/slack-approval-repository.js";
import { buildSlackDryRunQueue } from "../integrations/slack-dry-run.js";
import type { SlackRecipientDirectory } from "../integrations/slack-recipient-resolver.js";
import {
  evaluateSlackDispatchGate,
  type SlackDispatchGateSettings
} from "../integrations/slack-dispatch-gate.js";
export function createAdminRouter(
  repository: AdminRepository,
  matters: MatterRepository | undefined,
  history: SlackNotificationHistoryRepository | undefined,
  approvals: SlackNotificationApprovalRepository | undefined,
  slackRecipients: SlackRecipientDirectory,
  dispatchSettings: Pick<
    SlackDispatchGateSettings,
    "integrationMode" | "slackCapabilityEnabled" | "adapterConfigured"
  >,
  approvalWriteEnabled = false
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
      const dryRunQueue = buildSlackDryRunQueue(candidates, slackRecipients);
      let approvalRecords: Awaited<ReturnType<SlackNotificationApprovalRepository["listLatest"]>> = [];
      let approvalStatus: "disabled" | "connected" | "unavailable" = "disabled";
      if (approvals) {
        try {
          approvalRecords = await approvals.listLatest(
            rawCandidates.map((item) => item.issueKey)
          );
          approvalStatus = "connected";
        } catch (error) {
          approvalStatus = "unavailable";
          console.error("Slack notification approval lookup failed", {
            name: error instanceof Error ? error.name : "UnknownError"
          });
        }
      }
      const approvalByIssue = new Map(
        approvalRecords.map((item) => [item.issueKey, item])
      );
      const dispatchQueue = dryRunQueue.map((item) => {
        const approval = approvalByIssue.get(item.issueKey);
        return evaluateSlackDispatchGate(item, {
          ...dispatchSettings,
          historyConnected: historyStatus === "connected",
          approvedFingerprint:
            approval?.decision === "approved" ? approval.fingerprint : null
        });
      });
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
          dryRunSuppressed: dryRunQueue.filter((item) => item.readiness.startsWith("suppressed_")).length,
          dispatchAllowed: dispatchQueue.filter((item) => item.dispatchAllowed).length,
          dispatchBlocked: dispatchQueue.filter((item) => !item.dispatchAllowed).length,
          approvals: approvalRecords.filter((item) => item.decision === "approved").length,
          revocations: approvalRecords.filter((item) => item.decision === "revoked").length
        },
        history: {
          configured: Boolean(history),
          connected: historyStatus === "connected",
          status: historyStatus,
          externalSend: false
        },
        candidates,
        approvals: {
          configured: Boolean(approvals),
          connected: approvalStatus === "connected",
          status: approvalStatus,
          appendEnabled: approvalWriteEnabled,
          records: approvalRecords.map((item) => ({
            issueKey: item.issueKey,
            fingerprint: item.fingerprint,
            decision: item.decision,
            recordedAt: item.recordedAt
          }))
        },
        dispatch: {
          mode: "guarded",
          externalSend: false,
          adapterConfigured: dispatchSettings.adapterConfigured,
          queue: dispatchQueue
        },
        dryRun: {
          mode: "dry-run",
          externalSend: false,
          historyAppend: false,
          recipientDirectoryResolved: dryRunQueue.some((item) => item.target.resolution === "resolved"),
          queue: dryRunQueue
        }
      });
    } catch (error) { next(error); }
  });
  router.post("/admin/slack-notification-approvals", async (request, response, next) => {
    try {
      if (!approvalWriteEnabled || !approvals) {
        return response.status(403).json({
          error: "Slack approval writes are disabled",
          code: "SLACK_APPROVAL_DISABLED"
        });
      }
      const issueKey = typeof request.body?.issueKey === "string"
        ? request.body.issueKey.trim()
        : "";
      const fingerprint = typeof request.body?.fingerprint === "string"
        ? request.body.fingerprint.trim().toLowerCase()
        : "";
      const decision = request.body?.decision;
      if (!/^[A-Z][A-Z0-9_]*-[0-9]+$/.test(issueKey) ||
          !/^[a-f0-9]{64}$/.test(fingerprint) ||
          !["approved", "revoked"].includes(decision)) {
        return response.status(400).json({
          error: "Invalid Slack approval request",
          code: "SLACK_APPROVAL_INVALID"
        });
      }
      if (!matters || !history) {
        return response.status(503).json({
          error: "Slack approval prerequisites are unavailable",
          code: "SLACK_APPROVAL_UNAVAILABLE"
        });
      }
      const sourceMatters = await matters.list("", undefined, 200);
      const baseUrl = `${request.protocol}://${request.get("host")}`;
      const rawCandidates = buildSlackNotificationCandidates(sourceMatters, baseUrl);
      const historyRecords = await history.list(rawCandidates.map((item) => item.issueKey));
      const candidates = evaluateSlackCandidates(rawCandidates, historyRecords);
      const dryRunQueue = buildSlackDryRunQueue(candidates, slackRecipients);
      const candidate = candidates.find(
        (item) => item.issueKey === issueKey && item.fingerprint === fingerprint
      );
      const dryRun = dryRunQueue.find(
        (item) => item.issueKey === issueKey && item.fingerprint === fingerprint
      );
      if (!candidate || !dryRun) {
        return response.status(409).json({
          error: "Slack notification content has changed; reload before deciding",
          code: "SLACK_APPROVAL_STALE"
        });
      }
      if (dryRun.readiness !== "ready_for_review") {
        return response.status(409).json({
          error: "Slack notification is not ready for approval",
          code: "SLACK_APPROVAL_BLOCKED",
          readiness: dryRun.readiness,
          reasons: dryRun.blockingReasons
        });
      }
      await approvals.append({
        matterId: candidate.matterId,
        issueKey,
        fingerprint,
        decision,
        recordedBy: response.locals.currentUser!.email
      });
      return response.status(201).json({
        approval: { issueKey, fingerprint, decision },
        externalSend: false,
        historyAppend: false
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
