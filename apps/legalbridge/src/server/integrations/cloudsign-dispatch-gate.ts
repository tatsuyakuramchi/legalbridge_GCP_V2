import { isValidEmail, type CloudSignParticipant } from "./cloudsign-adapter.js";

// CloudSign 署名依頼の実発火ゲート。既定OFF・多重ブロックを重ね、全条件が
// 揃ったときだけ dispatchAllowed=true。

export type CloudSignDispatchBlocker =
  | "integration_local"
  | "capability_disabled"
  | "adapter_unavailable"
  | "participants_missing"
  | "participant_invalid"
  | "title_missing";

export interface CloudSignDispatchGateSettings {
  integrationMode: "local" | "live";
  cloudSignCapabilityEnabled: boolean;
  adapterConfigured: boolean;
}

export interface CloudSignDispatchPreview {
  documentTitle: string;
  participants: CloudSignParticipant[];
}

export interface CloudSignDispatchGateResult {
  dispatchAllowed: boolean;
  statusLabel: string;
  blockers: CloudSignDispatchBlocker[];
  blockerLabels: string[];
  externalSend: false;
}

const BLOCKER_LABELS: Record<CloudSignDispatchBlocker, string> = {
  integration_local: "統合モードがローカルのため外部送信は行いません",
  capability_disabled: "CloudSign依頼能力が無効です",
  adapter_unavailable: "CloudSignアダプタが未設定です（ベースURL・client_id）",
  participants_missing: "署名者が指定されていません",
  participant_invalid: "署名者のメールアドレスが不正です",
  title_missing: "文書タイトルが空です"
};

export function evaluateCloudSignDispatchGate(
  preview: CloudSignDispatchPreview,
  settings: CloudSignDispatchGateSettings
): CloudSignDispatchGateResult {
  const blockers: CloudSignDispatchBlocker[] = [];
  if (settings.integrationMode !== "live") blockers.push("integration_local");
  if (!settings.cloudSignCapabilityEnabled) blockers.push("capability_disabled");
  if (!settings.adapterConfigured) blockers.push("adapter_unavailable");
  if (!preview.participants.length) blockers.push("participants_missing");
  else if (!preview.participants.every((participant) => isValidEmail(participant.email))) {
    blockers.push("participant_invalid");
  }
  if (!preview.documentTitle.trim()) blockers.push("title_missing");

  const dispatchAllowed = blockers.length === 0;
  return {
    dispatchAllowed,
    statusLabel: dispatchAllowed ? "依頼可能" : "依頼ブロック中",
    blockers,
    blockerLabels: blockers.map((blocker) => BLOCKER_LABELS[blocker]),
    externalSend: false
  };
}
