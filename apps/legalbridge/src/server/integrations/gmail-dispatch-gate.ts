import { isValidEmail } from "./gmail-delivery-adapter.js";

// Gmail 送信の実発火ゲート。Slack と同じく、既定OFF・多重ブロックを重ねて
// 「設定が全て揃ったときだけ」dispatchAllowed=true にする。

export type GmailDispatchBlocker =
  | "integration_local"
  | "capability_disabled"
  | "adapter_unavailable"
  | "recipient_invalid"
  | "content_incomplete";

export interface GmailDispatchGateSettings {
  integrationMode: "local" | "live";
  gmailCapabilityEnabled: boolean;
  adapterConfigured: boolean;
  senderEmail: string;   // 送信元アドレス（From 構築に使用）
}

export interface GmailDispatchPreview {
  to: string;
  subject: string;
  bodyText: string;
}

export interface GmailDispatchGateResult {
  dispatchAllowed: boolean;
  statusLabel: string;
  blockers: GmailDispatchBlocker[];
  blockerLabels: string[];
  externalSend: false;
}

const BLOCKER_LABELS: Record<GmailDispatchBlocker, string> = {
  integration_local: "統合モードがローカルのため外部送信は行いません",
  capability_disabled: "Gmail送信能力が無効です",
  adapter_unavailable: "Gmail送信アダプタが未設定です（送信元・鍵）",
  recipient_invalid: "宛先メールアドレスが不正です",
  content_incomplete: "件名または本文が空です"
};

export function evaluateGmailDispatchGate(
  preview: GmailDispatchPreview,
  settings: GmailDispatchGateSettings
): GmailDispatchGateResult {
  const blockers: GmailDispatchBlocker[] = [];
  if (settings.integrationMode !== "live") blockers.push("integration_local");
  if (!settings.gmailCapabilityEnabled) blockers.push("capability_disabled");
  if (!settings.adapterConfigured) blockers.push("adapter_unavailable");
  if (!isValidEmail(preview.to)) blockers.push("recipient_invalid");
  if (!preview.subject.trim() || !preview.bodyText.trim()) blockers.push("content_incomplete");

  const dispatchAllowed = blockers.length === 0;
  return {
    dispatchAllowed,
    statusLabel: dispatchAllowed ? "送信可能" : "送信ブロック中",
    blockers,
    blockerLabels: blockers.map((blocker) => BLOCKER_LABELS[blocker]),
    externalSend: false
  };
}
