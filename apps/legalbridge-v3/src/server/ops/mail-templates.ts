/**
 * 文書を送るメールの文面（settings の mail_templates）。
 *
 * 画面（設定タブ・文書の「送る」）とサーバ（下書きを組む）の両方がここを読む。
 * ブラウザでも読むので、サーバ専用のものは import しない。
 *
 *   owner_check … 担当者（依頼した事業部の人）への確認。この内容で相手に出してよいか
 *   party_check … 取引先への内容確認。問題なければ CloudSign で締結へ
 *   inspection  … 検収書の送付（取引先へ）
 *   royalty     … 利用許諾計算書の送付（取引先へ）
 *   general     … その他の書類の送付（取引先へ）
 *
 * 既定の文面は V1（worker の DEFAULT_EMAIL_TPL）を引き継ぐ。
 */

export const MAIL_TEMPLATES_KEY = "mail_templates";

export type MailTemplateKind = "owner_check" | "party_check" | "inspection" | "royalty" | "general";
/** 送る画面で選ぶ「何のメールか」。送付は文書の種類で inspection / royalty / general に分かれる。 */
export type MailPurpose = "owner_check" | "party_check" | "delivery";

export interface MailTemplate { subject: string; body: string }
export interface MailTemplates {
  /** 本文の {署名} に入る。 */
  signature: string;
  /** 取引先へ送るメール（内容確認・送付）にいつも cc で入れる宛先。V1 の EMAIL_CC（経理など）。 */
  partyCc: string[];
  templates: Record<MailTemplateKind, MailTemplate>;
}

export const MAIL_TEMPLATE_KINDS: Array<{ kind: MailTemplateKind; label: string; hint: string }> = [
  { kind: "owner_check", label: "担当者への確認", hint: "依頼した事業部の担当者へ。相手に出す前に内容を確かめてもらう" },
  { kind: "party_check", label: "取引先への内容確認", hint: "取引先へ。問題なければ CloudSign で締結に進む" },
  { kind: "inspection", label: "検収書の送付", hint: "取引先へ。検収書を送る" },
  { kind: "royalty", label: "利用許諾計算書の送付", hint: "取引先へ。利用許諾料の計算書を送る" },
  { kind: "general", label: "その他の書類の送付", hint: "取引先へ。上のどれにも当たらない書類" }
];

/** 文面に差し込める項目。画面の説明にもそのまま出す。 */
export const MAIL_TEMPLATE_FIELDS: Array<{ name: string; label: string }> = [
  { name: "相手先", label: "取引先の名前" },
  { name: "宛名", label: "宛先の人の名前（担当者への確認なら担当者、取引先なら連絡先の人。分からなければ空）" },
  { name: "文書番号", label: "ARC-PO-2026-1001 など" },
  { name: "文書名", label: "ひな形の名前（発注書・検収書 など）" },
  { name: "案件番号", label: "MTR-2026-00012 など" },
  { name: "案件名", label: "案件の件名" },
  { name: "金額", label: "検収金額・利用許諾料額など（書類に載っている合計。無ければ空）" },
  { name: "発行日", label: "文書を決定した日" },
  { name: "会社名", label: "自社情報の会社名" },
  { name: "署名", label: "下の署名" }
];

const DEFAULT_SIGNATURE =
  "──────────────────────\n" +
  "株式会社アークライト\n" +
  "東京都千代田区神田小川町1-2　風雲堂ビル２階\n" +
  "経営管理本部　法務部\n" +
  "──────────────────────";

export const DEFAULT_MAIL_TEMPLATES: MailTemplates = {
  signature: DEFAULT_SIGNATURE,
  partyCc: [],
  templates: {
    owner_check: {
      subject: "【内容確認のお願い】{文書名}（{文書番号}）{相手先}",
      body:
        "{宛名} さん\n\nお疲れさまです。法務部です。\n\n" +
        "{案件番号} {案件名} の{文書名}を作成しました。\n添付の内容をご確認ください。\n\n" +
        "■ 相手先　：{相手先}\n■ 文書番号：{文書番号}\n\n" +
        "この内容で相手先へお送りしてよければ、本メールへご返信ください。\n" +
        "修正がある場合は、修正箇所をお知らせください。\n\n" +
        "よろしくお願いいたします。\n\n{署名}"
    },
    party_check: {
      subject: "【{会社名}】{文書名}のご確認のお願い（{文書番号}）",
      body:
        "{相手先} 御中\n{宛名} 様\n\nいつもお世話になっております。\n{会社名}でございます。\n\n" +
        "{文書名}を添付のとおりお送りいたします。\n" +
        "内容をご確認のうえ、問題がなければ本メールへのご返信にてお知らせください。\n" +
        "ご確認後、電子契約（クラウドサイン）にて締結のご案内をお送りいたします。\n\n" +
        "■ 文書番号：{文書番号}\n\n" +
        "修正のご希望がございましたら、お手数ですが修正箇所をお知らせください。\n\n" +
        "何卒よろしくお願い申し上げます。\n\n{署名}"
    },
    inspection: {
      subject: "【{会社名}】検収書のご送付（{文書番号}）",
      body:
        "{相手先} 御中\n{宛名} 様\n\nいつもお世話になっております。\n{会社名}でございます。\n\n" +
        "このたび納品いただきました内容につきまして検収が完了いたしましたので、\n" +
        "検収書を添付のとおりお送りいたします。\n\n" +
        "■ 文書番号：{文書番号}\n■ 検収金額：{金額}\n■ 発行日　：{発行日}\n\n" +
        "内容をご確認のうえ、相違等がございましたら、お手数ですが\n本メールへのご返信にてご連絡ください。\n" +
        "お支払いは、契約に定める支払条件に基づきお手続きいたします。\n\n" +
        "今後ともどうぞよろしくお願い申し上げます。\n\n{署名}"
    },
    royalty: {
      subject: "【{会社名}】利用許諾料計算書のご送付（{文書番号}）",
      body:
        "{相手先} 御中\n{宛名} 様\n\nいつも大変お世話になっております。\n{会社名}でございます。\n\n" +
        "このたび、利用許諾契約に基づく利用許諾料が確定いたしましたので、\n" +
        "利用許諾料計算書を添付のとおりお送りいたします。\n\n" +
        "■ 文書番号　　：{文書番号}\n■ 利用許諾料額：{金額}\n■ 発行日　　　：{発行日}\n\n" +
        "計算の内訳につきましては、添付の計算書をご確認ください。\n" +
        "お支払いは、契約に定める支払条件に基づきお手続きいたします。\n\n" +
        "なお、計算内容にご不明な点や相違等がございましたら、\n" +
        "お手数ですが本メールへご返信のうえお知らせくださいますようお願い申し上げます。\n\n" +
        "引き続きどうぞよろしくお願い申し上げます。\n\n{署名}"
    },
    general: {
      subject: "【{会社名}】書類のご送付（{文書番号}）",
      body:
        "{相手先} 御中\n{宛名} 様\n\nいつもお世話になっております。\n{会社名}でございます。\n\n" +
        "{文書名}を添付のとおりお送りいたします。\n\n" +
        "■ 文書番号：{文書番号}\n■ 発行日　：{発行日}\n\n" +
        "内容をご確認のうえ、ご不明な点がございましたら、お手数ですが\n本メールへのご返信にてご連絡ください。\n\n" +
        "今後ともどうぞよろしくお願い申し上げます。\n\n{署名}"
    }
  }
};

/** 送付のとき、文書の種類からどの文面を使うか。 */
export function deliveryKindOf(templateKey: string | null | undefined): MailTemplateKind {
  const k = String(templateKey ?? "");
  if (k.includes("inspection")) return "inspection";
  if (k.includes("royalty") || k.includes("license_calc")) return "royalty";
  return "general";
}

export function templateKindOf(purpose: MailPurpose, templateKey: string | null | undefined): MailTemplateKind {
  return purpose === "delivery" ? deliveryKindOf(templateKey) : purpose;
}

/**
 * 保存する値を確かめて整える。直せない誤りは理由の一覧を返す（保存しない）。
 * 画面の保存ボタンとサーバの PUT の両方で使う。
 */
export function parseMailTemplates(input: unknown): { value: MailTemplates; errors: string[] } {
  const src = (input && typeof input === "object" ? input : {}) as Record<string, any>;
  const d = DEFAULT_MAIL_TEMPLATES;
  const errors: string[] = [];
  const known = new Set(MAIL_TEMPLATE_FIELDS.map((f) => f.name));
  const templates = {} as Record<MailTemplateKind, MailTemplate>;
  for (const { kind, label } of MAIL_TEMPLATE_KINDS) {
    const t = src.templates?.[kind] ?? {};
    const subject = String(t.subject ?? d.templates[kind].subject);
    const body = String(t.body ?? d.templates[kind].body);
    if (!subject.trim()) errors.push(`${label}の件名が空です`);
    if (!body.trim()) errors.push(`${label}の本文が空です`);
    if (subject.length > 300) errors.push(`${label}の件名は 300 字までです`);
    if (body.length > 10000) errors.push(`${label}の本文は 10000 字までです`);
    for (const m of `${subject}\n${body}`.matchAll(/\{([^{}]+)\}/g)) {
      if (!known.has(m[1])) errors.push(`${label}の {${m[1]}} は差し込めません（使えるのは ${[...known].join("・")}）`);
    }
    templates[kind] = { subject, body };
  }
  const signature = String(src.signature ?? d.signature);
  if (signature.length > 2000) errors.push("署名は 2000 字までです");
  const rawCc = Array.isArray(src.partyCc) ? src.partyCc
    : typeof src.partyCc === "string" ? src.partyCc.split(/[,、\s]+/) : d.partyCc;
  const partyCc = [...new Set(rawCc.map((v: unknown) => String(v ?? "").trim()).filter(Boolean))] as string[];
  for (const e of partyCc) if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) errors.push(`cc の「${e}」はメールアドレスの形ではありません`);
  if (partyCc.length > 10) errors.push("いつも入れる cc は 10 件までです");
  return { value: { signature, partyCc, templates }, errors: [...new Set(errors)] };
}

/** 保存されている値を読む。壊れていても既定値で埋める（送る画面を止めない）。 */
export function readMailTemplates(stored: unknown): MailTemplates {
  return parseMailTemplates(stored ?? DEFAULT_MAIL_TEMPLATES).value;
}

/**
 * {差込} を埋める。値の無い差込は空にし、空になった「◯◯ 様」などの行は落とす
 * （宛名が分からないときに「 様」だけの行を出さない）。
 */
export function renderMail(
  template: MailTemplate, signature: string, values: Record<string, string>
): MailTemplate {
  const all: Record<string, string> = { ...values, 署名: signature };
  const fill = (text: string) => text.replace(/\{([^{}]+)\}/g, (_m, name) => all[name] ?? "");
  const body = fill(template.body)
    .split("\n")
    .filter((line) => !/^\s*(様|さん|御中)\s*$/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  return { subject: fill(template.subject).replace(/\s{2,}/g, " ").trim(), body: body.trim() };
}
