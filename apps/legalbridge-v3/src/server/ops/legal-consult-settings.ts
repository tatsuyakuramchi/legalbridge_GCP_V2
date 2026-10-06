/**
 * 法務相談窓口（Slack のチャンネル）の設定（settings の legal_consult）。
 *
 * 案件の「Slack で送る」から、このチャンネルに案件ごとのスレッドを立てて送る。
 * 旧版の SLACK_LEGAL_CONSULT_CHANNEL にあたる。画面（OpsWorkspace の設定タブ）と
 * サーバ（MatterCommunicationService）の両方がここを読む。ブラウザでも読むので、
 * サーバ専用のものは import しない。
 */

export const LEGAL_CONSULT_KEY = "legal_consult";

export interface LegalConsultSettings {
  /** チャンネル ID（C…）。空なら相談窓口へは送れない。 */
  channelId: string;
  /** 画面に出す呼び名（#法務相談 など）。 */
  label: string;
}

export const DEFAULT_LEGAL_CONSULT: LegalConsultSettings = { channelId: "", label: "" };

const SLACK_CHANNEL = /^[CG][A-Z0-9]{6,}$/;

export function parseLegalConsultSettings(
  input: unknown
): { value: LegalConsultSettings; errors: string[] } {
  const src = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const channelId = String(src.channelId ?? "").trim().toUpperCase();
  const label = String(src.label ?? "").trim().slice(0, 80);
  const errors: string[] = [];
  if (channelId && !SLACK_CHANNEL.test(channelId)) {
    errors.push(`チャンネル ID「${channelId}」の形が違います（C で始まる英数字。チャンネル名ではなく ID）`);
  }
  return { value: { channelId, label }, errors };
}

/** 保存されている値を読む。壊れていれば「未設定」として扱う。 */
export function readLegalConsultSettings(stored: unknown): LegalConsultSettings {
  const parsed = parseLegalConsultSettings(stored ?? DEFAULT_LEGAL_CONSULT);
  return parsed.errors.length ? DEFAULT_LEGAL_CONSULT : parsed.value;
}

/** Slack のメンバー ID（U… / W…）。 */
export const isSlackUserId = (value: unknown) => /^[UW][A-Z0-9]{6,}$/.test(String(value ?? ""));

/** 本文の頭にメンションを付ける。同じ人は 1 回。ID の形でないものは捨てる。 */
export function withMentions(body: string, mentions: unknown[] | null | undefined): string {
  const ids = [...new Set((mentions ?? []).map((m) => String(m ?? "").trim().toUpperCase()))].filter(isSlackUserId);
  return ids.length ? `${ids.map((id) => `<@${id}>`).join(" ")}\n${body}` : body;
}
