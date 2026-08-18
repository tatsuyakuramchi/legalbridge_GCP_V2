import { z } from "zod";
import { NOTIFICATION_SETTING_KEYS } from "../../notification-settings.js";

// システム設定（Phase 11-1）。共有 app_settings（key/value JSONB）を V2 が所有・編集する。
// 安全のため編集可能キーは会社プロファイル（表示用・非機密の業務設定）に allowlist する。
// 連携トグルや秘密（INTEGRATION_MODE・各種トークン等）は env/デプロイ管理のまま＝ここでは触らない。

export interface SettingField { key: string; label: string; placeholder?: string }

// 会社プロファイル（帳票・請求で使う自社情報）。値は文字列。
export const COMPANY_PROFILE_FIELDS: SettingField[] = [
  { key: "COMPANY_NAME", label: "会社名", placeholder: "アークライト株式会社" },
  { key: "COMPANY_NAME_KANA", label: "会社名（カナ）" },
  { key: "COMPANY_POSTAL_CODE", label: "郵便番号", placeholder: "100-0001" },
  { key: "COMPANY_ADDRESS", label: "住所" },
  { key: "COMPANY_TEL", label: "電話番号" },
  { key: "COMPANY_FAX", label: "FAX" },
  { key: "COMPANY_REPRESENTATIVE", label: "代表者" },
  // キー名は V1 が実際に読む COMPANY_INVOICE_NO に合わせる（V1 sharedReads.ts:239 参照・監査 P0-11）。
  { key: "COMPANY_INVOICE_NO", label: "適格請求書発行事業者番号（T番号）", placeholder: "T1234567890123" },
  { key: "COMPANY_BANK_INFO", label: "振込先（銀行・支店・口座）" },
  { key: "COMPANY_SEAL_NOTE", label: "捺印・備考" }
];

// 連携設定（非秘密の運用パラメータ・2-5 UI 化）。**秘密（APIキー・トークン・署名シークレット・
// CloudSign クライアントID・SA鍵）と live/disabled のモード切替は対象外**＝Secret Manager／
// デプロイ substitutions 管理のまま（verify ゲートの統制を迂回しない）。
// キー名は V1 の dbSettings（app_settings）と互換＝併走中は V1/V2 で同じ値を共有する。
// 反映タイミング：保存後、インスタンス起動時（再デプロイ/再起動）に環境変数へ上書き適用。
// 空欄＝デプロイ時の環境変数値を使用。
export const INTEGRATION_SETTING_FIELDS: SettingField[] = [
  { key: "BACKLOG_HOST", label: "Backlog ホスト", placeholder: "example.backlog.jp" },
  { key: "BACKLOG_PROJECT_KEY", label: "Backlog プロジェクトキー", placeholder: "LEGAL" },
  { key: "SLACK_LEGAL_CONSULT_CHANNEL", label: "Slack 法務相談チャンネルID", placeholder: "C0XXXXXXX" },
  { key: "GMAIL_SENDER", label: "Gmail 送信元アドレス", placeholder: "legal@example.co.jp" },
  { key: "GMAIL_INBOUND_MAILBOX", label: "Gmail 受信メールボックス", placeholder: "contracts@example.co.jp" },
  { key: "GMAIL_INBOUND_QUERY", label: "Gmail 受信検索クエリ", placeholder: "has:attachment filename:pdf newer_than:180d" },
  { key: "CLOUDSIGN_ALLOWED_RECIPIENTS", label: "CloudSign 宛先許可リスト（カンマ区切り・空=無制限）", placeholder: "test@example.co.jp,legal@example.co.jp" }
];

// 定期通知の宛先・ON/OFF（通知ごと）。定義は client と共有する notification-settings.ts が持ち、
// ここでは「保存を許すキー」としてだけ扱う（値は "true"/"false" とチャンネルID）。
export const ALLOWED_SETTING_KEYS = new Set([
  ...COMPANY_PROFILE_FIELDS.map((f) => f.key),
  ...INTEGRATION_SETTING_FIELDS.map((f) => f.key),
  ...NOTIFICATION_SETTING_KEYS
]);

// 保存リクエスト。全キーが allowlist 内・値は文字列（≤500）であることを要求する。
export const settingsSaveSchema = z.object({
  settings: z.record(z.string(), z.string().max(500))
}).superRefine((v, ctx) => {
  const keys = Object.keys(v.settings);
  if (keys.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "更新する設定がありません", path: ["settings"] });
  }
  for (const k of keys) {
    if (!ALLOWED_SETTING_KEYS.has(k)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `編集できない設定キーです: ${k}`, path: ["settings", k] });
    }
  }
});

export type SettingsSaveInput = z.infer<typeof settingsSaveSchema>;
