import type { SlackDryRunEnvelope } from "./slack-dry-run.js";

export type SlackDispatchBlocker =
  | "dry_run_incomplete"
  | "integration_local"
  | "capability_disabled"
  | "history_unavailable"
  | "approval_missing"
  | "approval_stale"
  | "adapter_unavailable";

export interface SlackDispatchGateSettings {
  integrationMode: "local" | "live";
  slackCapabilityEnabled: boolean;
  historyConnected: boolean;
  approvedFingerprint?: string | null;
  adapterConfigured: boolean;
}

export interface SlackDispatchGateResult {
  matterId: number;
  issueKey: string;
  fingerprint: string;
  dispatchAllowed: boolean;
  statusLabel: string;
  blockers: SlackDispatchBlocker[];
  blockerLabels: string[];
  externalSend: false;
}

export function evaluateSlackDispatchGate(
  envelope: SlackDryRunEnvelope,
  settings: SlackDispatchGateSettings
): SlackDispatchGateResult {
  const blockers: SlackDispatchBlocker[] = [];
  if (envelope.readiness !== "ready_for_review") {
    blockers.push("dry_run_incomplete");
  }
  if (settings.integrationMode !== "live") {
    blockers.push("integration_local");
  }
  if (!settings.slackCapabilityEnabled) {
    blockers.push("capability_disabled");
  }
  if (!settings.historyConnected) {
    blockers.push("history_unavailable");
  }
  if (!settings.approvedFingerprint) {
    blockers.push("approval_missing");
  } else if (settings.approvedFingerprint !== envelope.fingerprint) {
    blockers.push("approval_stale");
  }
  if (!settings.adapterConfigured) {
    blockers.push("adapter_unavailable");
  }

  return {
    matterId: envelope.matterId,
    issueKey: envelope.issueKey,
    fingerprint: envelope.fingerprint,
    dispatchAllowed: blockers.length === 0,
    statusLabel: blockers.length === 0 ? "送信条件充足" : "送信停止",
    blockers,
    blockerLabels: blockers.map((blocker) => blockerLabels[blocker]),
    externalSend: false
  };
}

const blockerLabels: Record<SlackDispatchBlocker, string> = {
  dry_run_incomplete: "ドライランの安全確認が完了していません",
  integration_local: "外部連携がlocalモードです",
  capability_disabled: "slack送信権限が有効ではありません",
  history_unavailable: "通知履歴へ接続できません",
  approval_missing: "現在の通知指紋に対する管理者承認がありません",
  approval_stale: "承認後に通知内容または宛先が変更されています",
  adapter_unavailable: "Slack送信アダプターが接続されていません"
};
