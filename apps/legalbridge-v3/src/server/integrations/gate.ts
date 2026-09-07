/**
 * 外部送信の段階開放ゲート（純関数・DB非依存）。
 *
 * V2 は Slack / Gmail / CloudSign でそれぞれ別のゲートを持ち、blocker の語彙も
 * バラバラだった。V3 は 1 本にまとめ、チャネルは引数で渡す。
 *
 * 段階は3つ。
 *   off      … 送らない。画面にも送信の導線を出さない。
 *   dry_run  … 送らずに「何が送られるか」だけを返す。宛先の検証に使う。
 *   live     … 実際に送る。
 *
 * 送信を止める理由は必ず列挙して返す。黙って送らないのが一番まずい。
 */

export type IntegrationChannel = "slack" | "gmail" | "cloudsign" | "backlog";
export type IntegrationMode = "off" | "dry_run" | "live";

export type DispatchBlocker =
  | "channel_off"          // 設定で無効
  | "dry_run"              // 検証モードなので送らない
  | "adapter_unconfigured" // 資格情報が無い
  | "read_only"            // 参照専用で起動している
  | "recipient_missing"    // 宛先が解決できない
  | "content_missing"      // 送る中身が無い（PDF未保存など）
  | "not_allowlisted";     // 検証中の宛先許可リストに無い

export const BLOCKER_LABEL: Record<DispatchBlocker, string> = {
  channel_off: "この連携は無効に設定されています",
  dry_run: "検証モードのため送信しません",
  adapter_unconfigured: "接続情報が設定されていません",
  read_only: "読み取り専用で動作しています",
  recipient_missing: "宛先が解決できません",
  content_missing: "送信する内容がありません",
  not_allowlisted: "検証中の宛先許可リストに入っていません"
};

export interface GateSettings {
  mode: IntegrationMode;
  adapterConfigured: boolean;
  readOnly: boolean;
  /** 検証中に送ってよい宛先。空なら制限しない。 */
  allowlist?: string[];
}

export interface GateInput {
  channel: IntegrationChannel;
  recipient?: string | null;
  hasContent?: boolean;
}

export interface GateResult {
  channel: IntegrationChannel;
  mode: IntegrationMode;
  /** 実際に送ってよいか。 */
  allowed: boolean;
  /** 送らないが「何が送られるか」を返してよいか。 */
  previewable: boolean;
  blockers: DispatchBlocker[];
  reasons: string[];
}

export function evaluateGate(input: GateInput, settings: GateSettings): GateResult {
  const blockers: DispatchBlocker[] = [];

  if (settings.mode === "off") blockers.push("channel_off");
  if (settings.mode === "dry_run") blockers.push("dry_run");
  if (!settings.adapterConfigured) blockers.push("adapter_unconfigured");
  if (settings.readOnly) blockers.push("read_only");
  if (input.recipient !== undefined && !String(input.recipient ?? "").trim()) {
    blockers.push("recipient_missing");
  }
  if (input.hasContent === false) blockers.push("content_missing");

  const allowlist = (settings.allowlist ?? []).map((v) => v.trim().toLowerCase()).filter(Boolean);
  const recipient = String(input.recipient ?? "").trim().toLowerCase();
  if (allowlist.length && recipient && !allowlist.includes(recipient)) {
    blockers.push("not_allowlisted");
  }

  return {
    channel: input.channel,
    mode: settings.mode,
    allowed: blockers.length === 0,
    // 検証モードだけが理由なら、中身の確認はできる。
    previewable: blockers.every((b) => b === "dry_run"),
    blockers,
    reasons: blockers.map((b) => BLOCKER_LABEL[b])
  };
}

export function parseMode(value: string | undefined | null): IntegrationMode {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "live" ? "live" : normalized === "dry_run" ? "dry_run" : "off";
}
