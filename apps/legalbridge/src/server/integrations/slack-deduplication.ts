import { createHash } from "node:crypto";
import type { SlackNotificationCandidate } from "./slack-candidates.js";

export type NotificationHistoryOutcome =
  | "sent"
  | "acknowledged"
  | "failed"
  | "cancelled";

export interface NotificationHistoryRecord {
  issueKey: string;
  fingerprint: string;
  outcome: NotificationHistoryOutcome;
  recordedAt: string;
}

export type NotificationEligibility =
  | "ready"
  | "duplicate"
  | "quiet"
  | "history_unavailable";

export interface EvaluatedSlackCandidate extends SlackNotificationCandidate {
  fingerprint: string;
  eligibility: NotificationEligibility;
  eligibilityLabel: string;
  previousNotificationAt: string | null;
}

export function notificationFingerprint(candidate: SlackNotificationCandidate) {
  const payload = JSON.stringify({
    issueKey: candidate.issueKey,
    requesterStatus: candidate.notification.requesterStatus,
    shouldNotify: candidate.notification.shouldNotify,
    nextAction: candidate.notification.nextAction,
    actions: candidate.notification.actions.map((action) => action.id)
  });
  return createHash("sha256").update(payload).digest("hex");
}

export function evaluateSlackCandidates(
  candidates: SlackNotificationCandidate[],
  history: NotificationHistoryRecord[] | null
): EvaluatedSlackCandidate[] {
  const historyByFingerprint = new Map(
    (history ?? [])
      .filter((record) => record.outcome === "sent" || record.outcome === "acknowledged")
      .map((record) => [record.issueKey + ":" + record.fingerprint, record])
  );

  return candidates.map((candidate) => {
    const fingerprint = notificationFingerprint(candidate);
    if (!candidate.notification.shouldNotify) {
      return evaluated(candidate, fingerprint, "quiet", "現在の状態では通知不要", null);
    }
    if (history === null) {
      return evaluated(
        candidate,
        fingerprint,
        "history_unavailable",
        "通知履歴の確認待ち",
        null
      );
    }
    const previous = historyByFingerprint.get(candidate.issueKey + ":" + fingerprint);
    if (previous) {
      return evaluated(
        candidate,
        fingerprint,
        "duplicate",
        "同じ内容を通知済み",
        previous.recordedAt
      );
    }
    return evaluated(candidate, fingerprint, "ready", "新しい通知候補", null);
  });
}

function evaluated(
  candidate: SlackNotificationCandidate,
  fingerprint: string,
  eligibility: NotificationEligibility,
  eligibilityLabel: string,
  previousNotificationAt: string | null
): EvaluatedSlackCandidate {
  return {
    ...candidate,
    fingerprint,
    eligibility,
    eligibilityLabel,
    previousNotificationAt
  };
}
