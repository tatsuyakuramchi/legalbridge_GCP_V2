import type { AppSettingsRepository } from "./settings-repository.js";
import { INTEGRATION_SETTING_FIELDS } from "./settings-schema.js";

// 連携設定の app_settings 上書き（2-5 UI 化）。設定画面（admin・guarded settings scope）で
// 保存された非秘密パラメータを、**サーバ起動時**に環境変数由来の config へ上書きする。
//   - 空欄・未設定キーは env 値のまま（フォールバック）。
//   - 秘密・モード切替は対象外（Secret Manager／デプロイ管理・settings-schema.ts 参照）。
//   - 起動時適用＝反映には再デプロイ/インスタンス再起動が必要（設定画面にも明記）。

export interface IntegrationOverridableConfig {
  backlogHost: string;
  backlogProjectKey: string;
  slackLegalConsultChannel: string;
  gmailSenderEmail: string;
  gmailInboundMailbox: string;
  gmailInboundQuery: string;
  cloudSignAllowedRecipients: string;
}

const KEY_TO_CONFIG: Array<[string, keyof IntegrationOverridableConfig]> = [
  ["BACKLOG_HOST", "backlogHost"],
  ["BACKLOG_PROJECT_KEY", "backlogProjectKey"],
  ["SLACK_LEGAL_CONSULT_CHANNEL", "slackLegalConsultChannel"],
  ["GMAIL_SENDER", "gmailSenderEmail"],
  ["GMAIL_INBOUND_MAILBOX", "gmailInboundMailbox"],
  ["GMAIL_INBOUND_QUERY", "gmailInboundQuery"],
  ["CLOUDSIGN_ALLOWED_RECIPIENTS", "cloudSignAllowedRecipients"]
];

export const INTEGRATION_SETTING_KEYS = INTEGRATION_SETTING_FIELDS.map((f) => f.key);

// 非空の設定値だけを config へ上書きし、適用したキー名を返す（純関数・テスト可能）。
export function applyIntegrationOverrides(
  target: IntegrationOverridableConfig,
  values: Record<string, string>
): string[] {
  const applied: string[] = [];
  for (const [key, prop] of KEY_TO_CONFIG) {
    const value = String(values[key] ?? "").trim();
    if (!value) continue;
    if (target[prop] !== value) target[prop] = value;
    applied.push(key);
  }
  return applied;
}

// 起動時ロード（失敗は env フォールバック＝起動を止めない）。
export async function loadIntegrationOverrides(
  settings: AppSettingsRepository
): Promise<Record<string, string>> {
  try {
    return await settings.get(INTEGRATION_SETTING_KEYS);
  } catch (error) {
    console.warn(
      "[settings] integration overrides load failed; using env values:",
      error instanceof Error ? error.message : String(error)
    );
    return {};
  }
}
