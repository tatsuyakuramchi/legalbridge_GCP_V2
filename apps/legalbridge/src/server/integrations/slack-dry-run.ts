import type { NotificationHistoryAppend } from "./slack-history-repository.js";
import type { EvaluatedSlackCandidate } from "./slack-deduplication.js";

export type SlackDryRunReadiness =
  | "ready_for_review"
  | "blocked_history"
  | "blocked_destination"
  | "blocked_link"
  | "suppressed_duplicate"
  | "suppressed_quiet";

export interface SlackDryRunEnvelope {
  matterId: number;
  issueKey: string;
  fingerprint: string;
  readiness: SlackDryRunReadiness;
  readinessLabel: string;
  blockingReasons: string[];
  target: {
    channelId: string | null;
    resolution: "configured" | "missing";
  };
  message: {
    headline: string;
    body: string;
    nextAction: string;
    actions: EvaluatedSlackCandidate["notification"]["actions"];
  };
  plannedHistoryEntry: Omit<NotificationHistoryAppend, "recordedBy"> & {
    recordedBy: "dry-run";
  };
  externalSend: false;
  historyAppend: false;
}

export function buildSlackDryRunQueue(
  candidates: EvaluatedSlackCandidate[],
  channelId?: string | null
): SlackDryRunEnvelope[] {
  const resolvedChannelId = normalizeChannelId(channelId);
  return candidates.map((candidate) => {
    const blockingReasons: string[] = [];
    let readiness: SlackDryRunReadiness;

    if (candidate.eligibility === "duplicate") {
      readiness = "suppressed_duplicate";
      blockingReasons.push("同じ案件状態と必要行動を通知済みです");
    } else if (candidate.eligibility === "quiet") {
      readiness = "suppressed_quiet";
      blockingReasons.push("現在の案件状態では利用者への通知は不要です");
    } else if (candidate.eligibility === "history_unavailable") {
      readiness = "blocked_history";
      blockingReasons.push("通知履歴を確認できないため重複判定ができません");
    } else if (!resolvedChannelId) {
      readiness = "blocked_destination";
      blockingReasons.push("検証用Slack送信先が設定されていません");
    } else if (!hasSafeActionLinks(candidate)) {
      readiness = "blocked_link";
      blockingReasons.push("LegalBridgeへの安全なHTTPSリンクを確認できません");
    } else {
      readiness = "ready_for_review";
    }

    return {
      matterId: candidate.matterId,
      issueKey: candidate.issueKey,
      fingerprint: candidate.fingerprint,
      readiness,
      readinessLabel: readinessLabels[readiness],
      blockingReasons,
      target: {
        channelId: resolvedChannelId,
        resolution: resolvedChannelId ? "configured" : "missing"
      },
      message: {
        headline: candidate.notification.headline,
        body: candidate.notification.body,
        nextAction: candidate.notification.nextAction,
        actions: candidate.notification.actions
      },
      plannedHistoryEntry: {
        matterId: candidate.matterId,
        issueKey: candidate.issueKey,
        fingerprint: candidate.fingerprint,
        requesterStatus: candidate.notification.requesterStatus,
        outcome: "sent",
        headline: candidate.notification.headline,
        triggerDetail: candidate.triggerDetail,
        slackChannelId: resolvedChannelId,
        slackMessageTs: null,
        recordedBy: "dry-run"
      },
      externalSend: false,
      historyAppend: false
    };
  });
}

const readinessLabels: Record<SlackDryRunReadiness, string> = {
  ready_for_review: "送信内容を確認可能",
  blocked_history: "履歴確認待ち",
  blocked_destination: "送信先未設定",
  blocked_link: "リンク確認待ち",
  suppressed_duplicate: "重複のため抑止",
  suppressed_quiet: "通知不要"
};

function normalizeChannelId(value?: string | null) {
  const normalized = value?.trim() ?? "";
  if (!normalized || normalized.toUpperCase() === "UNRESOLVED") return null;
  return normalized;
}

function hasSafeActionLinks(candidate: EvaluatedSlackCandidate) {
  return candidate.notification.actions.length > 0 &&
    candidate.notification.actions.every((action) => {
      try {
        return new URL(action.url).protocol === "https:";
      } catch {
        return false;
      }
    });
}
