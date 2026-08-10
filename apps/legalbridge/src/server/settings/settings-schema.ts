import { z } from "zod";

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

export const ALLOWED_SETTING_KEYS = new Set(COMPANY_PROFILE_FIELDS.map((f) => f.key));

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
