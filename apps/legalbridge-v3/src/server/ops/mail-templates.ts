/**
 * 文書を送るメールの文面（settings の mail_templates）。
 *
 * 画面（設定タブ・文書の「送る」）とサーバ（下書きを組む）の両方がここを読む。
 * ブラウザでも読むので、サーバ専用のものは import しない。
 *
 *   owner_check … 担当者（依頼した事業部の人）への確認。この内容で相手に出してよいか
 *   party_check … 取引先への内容確認。問題なければ CloudSign で締結へ
 *   contract_unify … 契約書の統一書式（書面化）のご案内。契約書案を添付し、問題なければ返信をもらって CloudSign へ
 *   inspection  … 検収書の送付（取引先へ）
 *   royalty     … 利用許諾計算書の送付（取引先へ）
 *   general     … その他の書類の送付（取引先へ）
 *
 * 既定の文面は V1（worker の DEFAULT_EMAIL_TPL）を引き継ぐ。
 */

export const MAIL_TEMPLATES_KEY = "mail_templates";

export type MailTemplateKind = "owner_check" | "party_check" | "contract_unify" | "inspection" | "royalty" | "general";
/** 送る画面で選ぶ「何のメールか」。送付は文書の種類で inspection / royalty / general に分かれる。 */
export type MailPurpose = "owner_check" | "party_check" | "contract_unify" | "delivery" | `custom:${string}`;

export interface MailTemplate { subject: string; body: string }
/**
 * 設定で足した文面。送る画面の「文面」に並び、purpose は custom:<key>。
 *   audience … 誰に送るか。party＝取引先（主担当へ）／owner＝社内の担当者（依頼者へ）
 */
export interface CustomMailTemplate extends MailTemplate {
  key: string; label: string; hint: string; audience: "party" | "owner";
}
export interface MailTemplates {
  /** 本文の {署名} に入る。 */
  signature: string;
  /** 取引先へ送るメール（内容確認・送付）にいつも cc で入れる宛先。V1 の EMAIL_CC（経理など）。 */
  partyCc: string[];
  templates: Record<MailTemplateKind, MailTemplate>;
  /** 足した文面（設定で増やせる）。 */
  custom: CustomMailTemplate[];
  /** 本文の {案内URL} に入る（契約書締結のご案内ページ）。 */
  guideUrl: string;
}

/** 送る画面の「文面」の選択肢（決まったもの）。足した文面は mailPurposeOptions で後ろに並ぶ。 */
export const MAIL_PURPOSES: Array<{ value: MailPurpose; label: string; hint: string }> = [
  { value: "owner_check", label: "担当者への確認", hint: "依頼した事業部の担当者へ。相手に出す前に内容を確かめてもらう" },
  { value: "party_check", label: "取引先への内容確認", hint: "取引先へ。問題なければ送付（CloudSign）に進む" },
  { value: "contract_unify", label: "契約書の統一のご案内", hint: "取引先へ。統一書式の契約書案を添付し、問題なければ 2 週間以内の返信をもらう" },
  { value: "delivery", label: "取引先へ送付（検収書・計算書など）", hint: "取引先へ書類を送る。検収書・利用許諾計算書は専用の文面、他は「その他の書類」" }
];
export const isCustomPurpose = (p: string): p is `custom:${string}` => p.startsWith("custom:");
export const customKeyOf = (p: string): string => p.replace(/^custom:/, "");
export const CUSTOM_KEY_RE = /^[a-z0-9_-]{1,40}$/;
/** 送る画面に出す文面の一覧（決まったもの＋足したもの）。 */
export function mailPurposeOptions(templates: MailTemplates): Array<{ value: MailPurpose; label: string; hint: string; audience: "party" | "owner" }> {
  return [
    ...MAIL_PURPOSES.map((p) => ({ ...p, audience: (p.value === "owner_check" ? "owner" : "party") as "party" | "owner" })),
    ...templates.custom.map((c) => ({ value: `custom:${c.key}` as MailPurpose, label: c.label, hint: c.hint, audience: c.audience }))
  ];
}
/** purpose から使う文面を引く。足した文面なら custom:<key> の文面、無ければ null。 */
export function resolveMailTemplate(templates: MailTemplates, purpose: MailPurpose, templateKey: string | null | undefined)
  : { kind: string; template: MailTemplate; audience: "party" | "owner" } | null {
  if (isCustomPurpose(purpose)) {
    const c = templates.custom.find((x) => x.key === customKeyOf(purpose));
    return c ? { kind: `custom:${c.key}`, template: { subject: c.subject, body: c.body }, audience: c.audience } : null;
  }
  const kind = templateKindOf(purpose, templateKey);
  return { kind, template: templates.templates[kind], audience: purpose === "owner_check" ? "owner" : "party" };
}

export const MAIL_TEMPLATE_KINDS: Array<{ kind: MailTemplateKind; label: string; hint: string }> = [
  { kind: "owner_check", label: "担当者への確認", hint: "依頼した事業部の担当者へ。相手に出す前に内容を確かめてもらう" },
  { kind: "party_check", label: "取引先への内容確認", hint: "取引先へ。問題なければ CloudSign で締結に進む" },
  { kind: "contract_unify", label: "契約書の統一（書面化）のご案内", hint: "取引先へ。統一書式の契約書案を添付し、問題なければ 2 週間以内に返信をもらって CloudSign で締結に進む" },
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
  { name: "担当者名", label: "法務の担当者の名前（文書の担当者。無ければ空）" },
  { name: "対象期間", label: "計算書の対象期間（計算書に載っている期間。無ければ空）" },
  { name: "支払予定日", label: "その文書から立てた支払の期日（無ければ空）" },
  { name: "案内URL", label: "下の「案内ページの URL」" },
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
    contract_unify: {
      subject: "【{会社名}】利用許諾契約書（統一書式）のご確認のお願い",
      body:
        "{相手先} 様\n\nいつも大変お世話になっております。\n" +
        "株式会社アークライト 経営管理本部 法務部の倉持でございます。\n\n" +
        "平素より弊社商品にご尽力を賜り、心より御礼申し上げます。\n\n" +
        "さて、当社では現在、著作物の利用許諾料（印税）をお支払いしている皆様との契約書面について、" +
        "内容の整理と書式の統一を進めております。\n" +
        "これまで契約書のお取り交わしがないままお支払いを続けていた方もいらっしゃいます。" +
        "当社の手続が行き届かず、ご迷惑をおかけしましたことをお詫び申し上げます。" +
        "また、すでに契約を締結いただいている皆様にも、契約内容をより分かりやすく管理するため、" +
        "統一書式でのお取り交わしをお願いしております。\n\n" +
        "つきましては、{相手先}様とのお取引について、統一書式による契約書案をご用意いたしました。\n\n" +
        "【契約書案の主な内容】\n" +
        "1. これまでのお取引条件（利用許諾料の料率・お支払い時期等）を、統一書式にて書面化したものです。\n" +
        "2. 契約の効力は、著作物の利用を開始した時点に遡って適用される形としております。\n" +
        "3. これまでにお支払い済みの利用許諾料は、本契約に基づくお支払いとして取り扱います。\n" +
        "4. すでに契約を締結いただいている場合は、従前の契約は本契約に置き換わります。\n\n" +
        "契約書案を本メールに添付しております。\n" +
        "内容をご確認のうえ、問題がございませんでしたら、本メールの受信から2週間以内に、" +
        "その旨を本メールへのご返信にてお知らせください。\n" +
        "ご返信をいただいた後、電子契約サービス（クラウドサイン）より、ご署名のご案内をお送りいたします。\n\n" +
        "契約書案の内容が、これまでのご認識や既存の契約内容と異なる点、ご不明な点がございましたら、" +
        "ご遠慮なく本メールへのご返信にてお知らせください。個別にご説明・調整させていただきます。\n\n" +
        "お手数をおかけいたしますが、何卒よろしくお願い申し上げます。\n\n{署名}"
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
  },
  custom: [
    {
      key: "royalty_contract_notice", label: "計算書の送付＋契約書のお取り交わしのお願い", audience: "party",
      hint: "取引先へ。利用許諾料計算書を添付して送り、あわせて統一書式の契約書のお取り交わしをお願いする",
      subject: "利用許諾料計算書のご送付と契約書のお取り交わしのお願い（{会社名}）",
      body:
        "{相手先} 様\n\n" +
        "いつも大変お世話になっております。\n{会社名} 経営管理本部 法務部の{担当者名}でございます。\n\n" +
        "平素より弊社商品にご尽力を賜り、心より御礼申し上げます。\n\n" +
        "■ 利用許諾料計算書のご送付\n" +
        "{対象期間}分の利用許諾料計算書を添付にてお送りいたします。\n" +
        "お支払いは{支払予定日}を予定しております。内容についてご不明な点がございましたら、下記までお問い合わせください。\n\n" +
        "■ 契約書のお取り交わしについてのお願い\n" +
        "当社では現在、利用許諾料をお支払いしている皆様との契約書面について、内容の整理と書式の統一を進めております。\n" +
        "契約書をお取り交わしいただいていない皆様、またすでに契約を締結いただいている皆様のいずれにも、統一書式による契約書のお取り交わしをお願いしております。\n\n" +
        "これまでのお取引条件を書面化し、著作物の利用開始時に遡って適用する内容です。詳しい内容とお手続の方法は、下記のご案内をご覧ください。\n\n" +
        "▶ 契約書締結のご案内\n{案内URL}\n\n" +
        "契約書に関してご不明な点や、これまでのご認識と異なる点がございましたら、ご署名の前にご遠慮なくお知らせください。\n\n" +
        "お手数をおかけいたしますが、何卒よろしくお願い申し上げます。\n\n{署名}"
    },
    {
      key: "unsigned_reminder", label: "契約未締結の締結案内", audience: "party",
      hint: "取引先へ。お送りした契約書がまだ締結されていないとき、締結をお願いする",
      subject: "【{会社名}】{文書名}のご締結のお願い（{文書番号}）",
      body:
        "{相手先} 御中\n{宛名} 様\n\nいつもお世話になっております。\n{会社名}でございます。\n\n" +
        "先にお送りしました{文書名}（{文書番号}）につきまして、ご締結がまだ確認できておりません。\n" +
        "お手数ですが、内容をご確認のうえ、ご締結のお手続きをお願いいたします。\n\n" +
        "▶ 契約書締結のご案内\n{案内URL}\n\n" +
        "ご不明な点やご修正のご希望がございましたら、本メールへご返信ください。\n" +
        "すでにお手続きいただいている場合は、行き違いをご容赦ください。\n\n" +
        "今後ともどうぞよろしくお願い申し上げます。\n\n{署名}"
    }
  ],
  guideUrl: ""
};

/** 送付のとき、文書の種類からどの文面を使うか。 */
export function deliveryKindOf(templateKey: string | null | undefined): MailTemplateKind {
  const k = String(templateKey ?? "");
  if (k.includes("inspection")) return "inspection";
  if (k.includes("royalty") || k.includes("license_calc")) return "royalty";
  return "general";
}

export function templateKindOf(purpose: MailPurpose, templateKey: string | null | undefined): MailTemplateKind {
  if (purpose === "delivery") return deliveryKindOf(templateKey);
  // 足した文面（custom:<key>）はここに来ない（resolveMailTemplate が先に引く）。来たら「その他の書類」。
  return isCustomPurpose(purpose) ? "general" : purpose;
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
  // 足した文面。key は英数字・_・-（送る画面の purpose になる）。label は必須。
  const custom: CustomMailTemplate[] = [];
  const rawCustom = Array.isArray(src.custom) ? src.custom : src.custom === undefined ? d.custom : [];
  const seen = new Set<string>();
  for (const [i, raw] of (rawCustom as unknown[]).entries()) {
    const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
    const label = String(c.label ?? "").trim();
    const where = label || `足した文面 ${i + 1}`;
    const key = String(c.key ?? "").trim();
    if (!CUSTOM_KEY_RE.test(key)) errors.push(`${where}の鍵は英小文字・数字・_・- の 1〜40 字にしてください`);
    else if (seen.has(key)) errors.push(`${where}の鍵「${key}」が重なっています`);
    seen.add(key);
    if (!label) errors.push(`足した文面 ${i + 1} の名前が空です`);
    if (label.length > 60) errors.push(`${where}の名前は 60 字までです`);
    const subject = String(c.subject ?? ""); const body = String(c.body ?? "");
    if (!subject.trim()) errors.push(`${where}の件名が空です`);
    if (!body.trim()) errors.push(`${where}の本文が空です`);
    if (subject.length > 300) errors.push(`${where}の件名は 300 字までです`);
    if (body.length > 10000) errors.push(`${where}の本文は 10000 字までです`);
    for (const m of `${subject}\n${body}`.matchAll(/\{([^{}]+)\}/g)) {
      if (!known.has(m[1])) errors.push(`${where}の {${m[1]}} は差し込めません（使えるのは ${[...known].join("・")}）`);
    }
    custom.push({ key, label, hint: String(c.hint ?? "").slice(0, 200), audience: c.audience === "owner" ? "owner" : "party", subject, body });
  }
  if (custom.length > 30) errors.push("足せる文面は 30 までです");
  const signature = String(src.signature ?? d.signature);
  if (signature.length > 2000) errors.push("署名は 2000 字までです");
  const rawCc = Array.isArray(src.partyCc) ? src.partyCc
    : typeof src.partyCc === "string" ? src.partyCc.split(/[,、\s]+/) : d.partyCc;
  const partyCc = [...new Set(rawCc.map((v: unknown) => String(v ?? "").trim()).filter(Boolean))] as string[];
  for (const e of partyCc) if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) errors.push(`cc の「${e}」はメールアドレスの形ではありません`);
  if (partyCc.length > 10) errors.push("いつも入れる cc は 10 件までです");
  const guideUrl = String(src.guideUrl ?? d.guideUrl).trim();
  if (guideUrl.length > 500) errors.push("案内ページの URL は 500 字までです");
  return { value: { signature, partyCc, templates, custom, guideUrl }, errors: [...new Set(errors)] };
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
