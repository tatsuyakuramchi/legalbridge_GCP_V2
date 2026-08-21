import type { AppSettingsRepository } from "./settings-repository.js";

// メール送信設定（文面テンプレート＋既定CC）。V1 の loadEmailCfg（app_settings の
// email_subject_* / email_body_* / email_cc）を移植する。キー名は V1 互換＝共有
// app_settings 上で V1 と同じ値を読める。空欄＝既定文面（V1 の既定テンプレート）。
// プレースホルダーは {{token}} 形式。設定画面は EMAIL_TOKENS から選択挿入させる
// （手打ちによるトークン名間違いを防ぐ）。

export type EmailKind = "inspection" | "royalty" | "general";

export const EMAIL_SETTING_KEYS = [
  "email_cc",
  "email_subject_inspection", "email_body_inspection",
  "email_subject_royalty", "email_body_royalty",
  "email_subject_general", "email_body_general"
] as const;

export interface EmailToken { token: string; label: string; sample: string }

// 設定画面の「挿入」候補（= 置換される全トークン）。sample はプレビュー用の架空値。
export const EMAIL_TOKENS: EmailToken[] = [
  { token: "{{vendorName}}", label: "相手方名称", sample: "架空商事株式会社" },
  { token: "{{documentNumber}}", label: "文書番号", sample: "ARC-INS-2026-0031" },
  { token: "{{title}}", label: "文書の件名", sample: "キービジュアル制作委託" },
  { token: "{{amount}}", label: "金額（検収金額／利用許諾料額）", sample: "¥220,000" },
  { token: "{{date}}", label: "発行日（送信日）", sample: "2026/8/21" },
  { token: "{{link}}", label: "文書URL（Drive）", sample: "https://drive.google.com/file/d/…" },
  { token: "{{deliveryMethod}}", label: "添付のとおり／下記URLのとおり（添付結果で自動切替）", sample: "添付のとおり" },
  { token: "{{companyName}}", label: "自社名（会社プロフィール）", sample: "株式会社アークライト" },
  { token: "{{companyAddress}}", label: "自社住所（会社プロフィール）", sample: "東京都千代田区神田小川町1-2 風雲堂ビル2階" },
  { token: "{{companyTel}}", label: "自社TEL（会社プロフィール）", sample: "03-0000-0000" }
];

export interface EmailTemplate { subject: string; body: string }

// 既定テンプレート（V1 の DEFAULT_EMAIL_TPL を移植・トークン化）。
// 値が空の行（■ 金額：/文書URL：/TEL：）は描画後に自動で落ちる（cleanupRenderedBody）。
export const DEFAULT_EMAIL_TEMPLATES: Record<EmailKind, EmailTemplate> = {
  inspection: {
    subject: "【{{companyName}}】検収書のご送付（{{documentNumber}}）",
    body: [
      "{{vendorName}} 御中",
      "",
      "いつもお世話になっております。",
      "{{companyName}}でございます。",
      "",
      "このたび納品いただきました内容につきまして検収が完了いたしましたので、",
      "検収書を{{deliveryMethod}}お送りいたします。",
      "",
      "■ 文書番号：{{documentNumber}}",
      "■ 検収金額：{{amount}}",
      "■ 発行日　：{{date}}",
      "",
      "文書URL：{{link}}",
      "",
      "内容をご確認のうえ、相違等がございましたら、お手数ですが",
      "本メールへのご返信にてご連絡ください。",
      "お支払いは、契約に定める支払条件に基づきお手続きいたします。",
      "",
      "今後ともどうぞよろしくお願い申し上げます。",
      "",
      "──────────────────────",
      "{{companyName}}",
      "{{companyAddress}}",
      "TEL：{{companyTel}}",
      "──────────────────────"
    ].join("\n")
  },
  royalty: {
    subject: "【{{companyName}}】利用許諾料計算書のご送付（{{documentNumber}}）",
    body: [
      "{{vendorName}} 御中",
      "",
      "いつも大変お世話になっております。",
      "{{companyName}}でございます。",
      "",
      "このたび、利用許諾契約に基づく利用許諾料が確定いたしましたので、",
      "利用許諾料計算書を{{deliveryMethod}}お送りいたします。",
      "",
      "■ 文書番号：{{documentNumber}}",
      "■ 利用許諾料額：{{amount}}",
      "■ 発行日　：{{date}}",
      "",
      "文書URL：{{link}}",
      "",
      "計算の内訳につきましては、計算書をご確認ください。",
      "お支払いは、契約に定める支払条件に基づきお手続きいたします。",
      "",
      "なお、計算内容にご不明な点や相違等がございましたら、",
      "お手数ですが本メールへご返信のうえお知らせくださいますよう",
      "お願い申し上げます。",
      "",
      "引き続きどうぞよろしくお願い申し上げます。",
      "",
      "──────────────────────",
      "{{companyName}}",
      "{{companyAddress}}",
      "TEL：{{companyTel}}",
      "──────────────────────"
    ].join("\n")
  },
  general: {
    subject: "【{{companyName}}】書類のご送付（{{documentNumber}}）",
    body: [
      "{{vendorName}} 御中",
      "",
      "いつもお世話になっております。",
      "{{companyName}}でございます。",
      "",
      "書類（{{title}}）を{{deliveryMethod}}お送りいたします。",
      "",
      "■ 文書番号：{{documentNumber}}",
      "■ 発行日　：{{date}}",
      "",
      "文書URL：{{link}}",
      "",
      "内容をご確認のうえ、相違等がございましたら、お手数ですが",
      "本メールへのご返信にてご連絡ください。",
      "",
      "今後ともどうぞよろしくお願い申し上げます。",
      "",
      "──────────────────────",
      "{{companyName}}",
      "{{companyAddress}}",
      "TEL：{{companyTel}}",
      "──────────────────────"
    ].join("\n")
  }
};

export interface EmailSettings {
  cc: string;                                   // 既定CC（カンマ区切り・空可）
  templates: Record<EmailKind, EmailTemplate>;  // 空欄は既定で埋めた実効値
  custom: Record<string, string>;               // 保存されている生の値（設定画面用）
}

export const DEFAULT_EMAIL_SETTINGS: EmailSettings = {
  cc: "",
  templates: DEFAULT_EMAIL_TEMPLATES,
  custom: {}
};

// app_settings から読み、空欄キーは既定へ縮退（会社プロフィールと同じ縮退方針）。
export async function loadEmailSettings(
  settings: AppSettingsRepository | null | undefined
): Promise<EmailSettings> {
  if (!settings) return DEFAULT_EMAIL_SETTINGS;
  try {
    const values = await settings.get([...EMAIL_SETTING_KEYS]);
    const pick = (key: string) => String(values[key] ?? "").trim();
    const tpl = (kind: EmailKind): EmailTemplate => ({
      subject: pick(`email_subject_${kind}`) || DEFAULT_EMAIL_TEMPLATES[kind].subject,
      body: pick(`email_body_${kind}`) || DEFAULT_EMAIL_TEMPLATES[kind].body
    });
    return {
      cc: pick("email_cc"),
      templates: { inspection: tpl("inspection"), royalty: tpl("royalty"), general: tpl("general") },
      custom: values
    };
  } catch {
    return DEFAULT_EMAIL_SETTINGS;   // 表未整備・権限不足でも送信は既定文面で成立させる
  }
}

// {{token}} を値へ置換（V1 applyEmailTokens 相当）。未知トークンはそのまま残す。
export function applyEmailTokens(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : whole);
}

// 値が空のまま残った行（■ …：／文書URL：／TEL：）を落とし、空行の連続を1つに整える。
export function cleanupRenderedBody(body: string): string {
  const lines = body.split("\n").filter((line) => {
    const t = line.trim();
    return !(/^(■ .+：|文書URL：|TEL：)$/.test(t));
  });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "");
}

// 既定CC＋都度CCをマージして重複除去し、宛先と重なるCCを除外する（V1 と同じ規則）。
export function mergeCc(defaultCc: string, extraCc: string, recipients: string[]): string[] {
  const lowerTo = new Set(recipients.map((r) => r.toLowerCase()));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of `${defaultCc},${extraCc}`.split(",")) {
    const email = piece.trim();
    if (!email) continue;
    const key = email.toLowerCase();
    if (seen.has(key) || lowerTo.has(key)) continue;
    seen.add(key);
    out.push(email);
  }
  return out;
}
