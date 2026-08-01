import type { MatterSummary } from "../matters/repository.js";
import {
  buildSlackNotificationPreview,
  type SlackNotificationPreview
} from "./slack-ux.js";

export interface SlackNotificationCandidate {
  matterId: number;
  matterCode: string | null;
  issueKey: string;
  title: string;
  lifecycleStage: string | null;
  sourceUpdatedAt: string;
  trigger: "requester_input" | "requester_confirmation" | "lifecycle";
  triggerDetail: string;
  notification: SlackNotificationPreview;
  deliveryState: "not_evaluated";
}

const requesterConfirmationPattern =
  /依頼者確認|申請者確認|内容確認|承認待ち|回答内容の確認/i;
const requesterInputPattern =
  /依頼者|申請者|情報不足|追加情報|追加入力|回答待ち|差戻し/i;

export function buildSlackNotificationCandidates(
  matters: MatterSummary[],
  legalBridgeBaseUrl: string
): SlackNotificationCandidate[] {
  return matters
    .filter((matter) => Boolean(matter.primaryIssueKey))
    .map((matter) => {
      const signal = requesterSignal(matter);
      const notification = buildSlackNotificationPreview({
        issueKey: matter.primaryIssueKey!,
        title: matter.title,
        lifecycleStage: matter.lifecycleStage,
        needsRequesterInput: signal.needsRequesterInput,
        requesterConfirmationRequired: signal.requesterConfirmationRequired,
        legalBridgeBaseUrl
      });
      return {
        matterId: matter.id,
        matterCode: matter.matterCode,
        issueKey: matter.primaryIssueKey!,
        title: matter.title,
        lifecycleStage: matter.lifecycleStage,
        sourceUpdatedAt: matter.updatedAt,
        trigger: signal.trigger,
        triggerDetail: signal.detail,
        notification,
        deliveryState: "not_evaluated" as const
      };
    })
    .sort((left, right) => {
      if (left.notification.shouldNotify !== right.notification.shouldNotify) {
        return left.notification.shouldNotify ? -1 : 1;
      }
      return right.sourceUpdatedAt.localeCompare(left.sourceUpdatedAt);
    });
}

export function requesterSignal(matter: Pick<
  MatterSummary,
  "blockedReason" | "nextTaskTitle"
>) {
  const blockedReason = matter.blockedReason?.trim() ?? "";
  const nextTaskTitle = matter.nextTaskTitle?.trim() ?? "";
  const sourceText = [blockedReason, nextTaskTitle].filter(Boolean).join("／");

  if (requesterConfirmationPattern.test(sourceText)) {
    return {
      needsRequesterInput: false,
      requesterConfirmationRequired: true,
      trigger: "requester_confirmation" as const,
      detail: sourceText || "依頼者による内容確認"
    };
  }
  if (requesterInputPattern.test(sourceText)) {
    return {
      needsRequesterInput: true,
      requesterConfirmationRequired: false,
      trigger: "requester_input" as const,
      detail: sourceText || "依頼者による情報追加"
    };
  }
  return {
    needsRequesterInput: false,
    requesterConfirmationRequired: false,
    trigger: "lifecycle" as const,
    detail: "案件工程から判定"
  };
}
