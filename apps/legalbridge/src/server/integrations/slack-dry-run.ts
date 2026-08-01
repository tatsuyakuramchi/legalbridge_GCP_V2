import type { NotificationHistoryAppend } from "./slack-history-repository.js";
import type { EvaluatedSlackCandidate } from "./slack-deduplication.js";
import type {
  SlackRecipientDirectory,
  SlackRecipientTarget
} from "./slack-recipient-resolver.js";

export type SlackDryRunReadiness =
  | "ready_for_review"
  | "blocked_history"
  | "blocked_recipient"
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
  target: SlackRecipientTarget;
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
  recipients: SlackRecipientDirectory
): SlackDryRunEnvelope[] {
  return candidates.map((candidate) => {
    const blockingReasons: string[] = [];
    const recipient = recipients.resolve(candidate.requesterEmail);
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
    } else if (recipient.resolution !== "resolved") {
      readiness = "blocked_recipient";
      blockingReasons.push(recipientBlockingReason(recipient.resolution));
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
      target: recipient,
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
        slackChannelId: null,
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
  blocked_recipient: "宛先解決待ち",
  blocked_link: "リンク確認待ち",
  suppressed_duplicate: "重複のため抑止",
  suppressed_quiet: "通知不要"
};

function recipientBlockingReason(
  resolution: SlackRecipientTarget["resolution"]
) {
  switch (resolution) {
    case "missing_identity":
      return "案件から依頼者メールを特定できません";
    case "unmapped":
      return "依頼者メールに対応するSlackユーザーが登録されていません";
    case "ambiguous":
      return "依頼者メールに複数のSlackユーザーが登録されています";
    case "invalid":
      return "登録されたSlackユーザーIDの形式が不正です";
    default:
      return "Slack通知先を確認できません";
  }
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
