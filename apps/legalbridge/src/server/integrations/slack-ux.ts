export type RequesterStatus =
  | "intake"
  | "information_required"
  | "legal_review"
  | "requester_review"
  | "execution"
  | "completed"
  | "withdrawn";

export interface SlackUxInput {
  issueKey: string;
  title: string;
  lifecycleStage?: string | null;
  needsRequesterInput?: boolean;
  requesterConfirmationRequired?: boolean;
  legalBridgeUrl: string;
}

export interface SlackAction {
  id: "open_request" | "add_information" | "confirm_request";
  label: string;
  url: string;
  style: "primary" | "default";
}

export interface SlackNotificationPreview {
  issueKey: string;
  requesterStatus: RequesterStatus;
  statusLabel: string;
  headline: string;
  body: string;
  nextAction: string;
  shouldNotify: boolean;
  actions: SlackAction[];
  delivery: {
    newRootMessage: boolean;
    useExistingMatterThread: boolean;
  };
}

const statusContent: Record<RequesterStatus, {
  label: string;
  headline: string;
  body: string;
  nextAction: string;
  shouldNotify: boolean;
}> = {
  intake: {
    label: "受付",
    headline: "法務依頼を受け付けました",
    body: "受付内容を法務部で確認します。",
    nextAction: "追加の依頼があるまでお待ちください。",
    shouldNotify: true
  },
  information_required: {
    label: "情報確認",
    headline: "追加情報が必要です",
    body: "法務対応を進めるため、依頼内容の追加をお願いします。",
    nextAction: "「不足情報を入力」から対象フォームを更新してください。",
    shouldNotify: true
  },
  legal_review: {
    label: "法務対応",
    headline: "法務部で対応中です",
    body: "法務部が契約内容または文書を確認しています。",
    nextAction: "法務部から連絡があるまでお待ちください。",
    shouldNotify: false
  },
  requester_review: {
    label: "依頼者確認",
    headline: "依頼者の確認が必要です",
    body: "法務部から確認事項または文書案があります。",
    nextAction: "「内容を確認」から回答してください。",
    shouldNotify: true
  },
  execution: {
    label: "締結・実行",
    headline: "締結・実行手続中です",
    body: "文書確定後の締結または社内手続を進めています。",
    nextAction: "手続完了までお待ちください。",
    shouldNotify: false
  },
  completed: {
    label: "完了",
    headline: "法務依頼が完了しました",
    body: "依頼された法務対応が完了しました。",
    nextAction: "「依頼内容を確認」から完成文書と対応内容を確認できます。",
    shouldNotify: true
  },
  withdrawn: {
    label: "取下げ",
    headline: "法務依頼を終了しました",
    body: "この依頼は取下げまたは中止として終了しました。",
    nextAction: "必要な場合は新しい法務依頼を開始してください。",
    shouldNotify: true
  }
};

export function requesterStatus(input: Pick<
  SlackUxInput,
  "lifecycleStage" | "needsRequesterInput" | "requesterConfirmationRequired"
>): RequesterStatus {
  if (input.needsRequesterInput) return "information_required";
  if (input.requesterConfirmationRequired) return "requester_review";

  switch (input.lifecycleStage) {
    case "intake":
    case "triage":
      return "intake";
    case "drafting":
    case "internal_review":
    case "counterparty_review":
      return "legal_review";
    case "signing":
    case "performance":
    case "inspection":
    case "invoicing_payment":
    case "completion_check":
      return "execution";
    case "completed":
      return "completed";
    case "cancelled":
      return "withdrawn";
    default:
      return "intake";
  }
}

export function buildSlackNotificationPreview(
  input: SlackUxInput
): SlackNotificationPreview {
  const status = requesterStatus(input);
  const content = statusContent[status];
  const actions: SlackAction[] = [{
    id: "open_request",
    label: status === "requester_review" ? "内容を確認" : "依頼内容を確認",
    url: input.legalBridgeUrl,
    style: "primary"
  }];

  if (status === "information_required") {
    actions.unshift({
      id: "add_information",
      label: "不足情報を入力",
      url: input.legalBridgeUrl,
      style: "primary"
    });
    actions[1] = { ...actions[1], style: "default" };
  }
  if (status === "requester_review") {
    actions.push({
      id: "confirm_request",
      label: "確認結果を回答",
      url: input.legalBridgeUrl,
      style: "default"
    });
  }

  return {
    issueKey: input.issueKey,
    requesterStatus: status,
    statusLabel: content.label,
    headline: content.headline,
    body: `${input.title}：${content.body}`,
    nextAction: content.nextAction,
    shouldNotify: content.shouldNotify,
    actions,
    delivery: {
      newRootMessage: status === "intake",
      useExistingMatterThread: status !== "intake"
    }
  };
}

export function slackUxPreviewCatalog(baseUrl = "https://legalbridge.example") {
  const scenarios: Array<Pick<SlackUxInput,
    "lifecycleStage" | "needsRequesterInput" | "requesterConfirmationRequired"
  >> = [
    { lifecycleStage: "intake" },
    { lifecycleStage: "triage", needsRequesterInput: true },
    { lifecycleStage: "internal_review" },
    { lifecycleStage: "internal_review", requesterConfirmationRequired: true },
    { lifecycleStage: "signing" },
    { lifecycleStage: "completed" },
    { lifecycleStage: "cancelled" }
  ];

  return scenarios.map((scenario, index) => buildSlackNotificationPreview({
    ...scenario,
    issueKey: `LEGAL-PREVIEW-${index + 1}`,
    title: "海外ライセンス契約の確認",
    legalBridgeUrl: `${baseUrl}/?view=matters&issue=LEGAL-PREVIEW-${index + 1}`
  }));
}
