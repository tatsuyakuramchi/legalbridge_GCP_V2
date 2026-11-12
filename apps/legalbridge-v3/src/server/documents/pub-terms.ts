/**
 * 出版等利用許諾条件書（pub_license_terms_v3）。
 *
 * V2 の pub_license_terms は許諾料を「1枚に1つ」しか書けなかった（本文の
 * 対価の条に料率を差し込む作り）。実際の条件書は1枚に20作品が並び、紙と
 * 電子で料率が違う。そこで V3 のひな形は：
 *
 *   ・対象著作物の一覧に「紙 料率／独占区分」「電子 料率／独占区分」の列を持つ
 *   ・対価の条は固定文言にして、一覧の欄を参照する
 *   ・作品ごとの取り決め（初版部数など）は一覧の備考に書く
 *
 * 一覧の行は条件明細から組む。作品1点＝条件2本（媒体＝紙／電子）で、
 * 同じ作品の2本を1行に畳む。電子の条件が無い作品は「—」。V1・V2 は
 * この表を人が手で打っていた（打った内容は台帳に戻らない）。V3 は台帳が
 * 先にあるので、紙は台帳の写しになる。
 *
 * 甲＝許諾者＝取引先（著作権者）、乙＝被許諾者＝当社。条件は IN（当社が
 * 受ける許諾）で、振込先は取引先の口座。
 */

import { inLieuPaidNote } from "../conditions/royalty-in-lieu.js";
import type { TemplateVariable } from "./binding.js";
import type { Warning } from "./preflight.js";
import { type PubMedia, pubMediaOfScopes } from "../core/pub-media.js";
import { isSublicensingUsage, pubMediaOfUsage } from "../core/condition-usage.js";
import { renewalLabel, renewalOf } from "../conditions/renewal.js";
import { contextMasterAgreement } from "./legacy-variables.js";

export const PUB_TERMS_KEY = "pub_license_terms_v3";
/**
 * 別紙形式。作品が多い条件書で使う。
 *
 * 一覧を第１条に置くと、作品 80 点では条文の前に表が 4 ページ半続き、相手が
 * 先に読みたい条文が 5 ページ目になる。別紙形式は本文（条文と署名欄）を
 * 2 ページで閉じ、一覧を「別紙1」として後ろに出す。
 * 作品が数点なら一覧が前にあるほうが読みやすいので、両方を残して選ばせる。
 * 項目・値の出どころ・一覧の組み方は同じで、本文の組み方だけが違う。
 */
export const PUB_TERMS_ANNEX_KEY = "pub_license_terms_v3_annex";
/**
 * 作品ごとに番号を持つ条件書（A4 横。DucQrews の条件書をひな形にしたもの）。
 *
 * 1 枚の紙に作品を何点も並べ、作品ごとに個別利用許諾番号（作品の個別契約＝基本契約の下の
 * supplement の番号。ARC-PUBT-…）を振る。紙そのものの番号は別の頭（ARC-PUBS-…）。
 * 料率・期間・地域は紙 1 枚で 1 つ（作品で違うものは別の紙に分ける。警告で知らせる）。
 * 条文のうち、支払時期・共著者分の支払・旧合意・特記事項などは文書ごとに直せる文言（初期値あり）。
 */
export const PUB_TERMS_MULTI_KEY = "pub_license_terms_multi";
export const PUB_TERMS_KEYS: readonly string[] = [PUB_TERMS_KEY, PUB_TERMS_ANNEX_KEY, PUB_TERMS_MULTI_KEY];
/** 作品ごとに番号を持つ条件書か。 */
export const isPubTermsMulti = (templateKey: string): boolean => templateKey === PUB_TERMS_MULTI_KEY;
export const isPubTermsTemplate = (templateKey: string): boolean => PUB_TERMS_KEYS.includes(templateKey);
/** 別紙形式か（本文の組み方の違い。警告の出し分けに使う）。 */
export const isPubTermsAnnex = (templateKey: string): boolean => templateKey === PUB_TERMS_ANNEX_KEY;

/** これを超えたら別紙形式を勧める作品数。A4 縦で本文の前に表が1ページ以上続く目安。 */
export const PUB_TITLES_ANNEX_HINT = 12;

/**
 * どちらのひな形を選ぶかの手がかり（A-038）。
 *
 * 以前はひな形の名前に「作品が少ないとき／多いとき」を入れていたが、名前は
 * 文書の一覧の「種別」の列にも出るので、狭い欄では表が壊れる。名前は形式だけ
 * にして、手がかりはひな形を選ぶところに出す。
 */
export const PUB_TERMS_TEMPLATE_HINT: Record<string, string> = {
  [PUB_TERMS_KEY]: `作品が少ないとき向け。対象著作物の一覧が第１条に出る（${PUB_TITLES_ANNEX_HINT} 点あたりまで）`,
  [PUB_TERMS_ANNEX_KEY]: "作品が多いとき向け。条文を先に読み切れるよう、一覧は末尾の別紙1に出る",
  [PUB_TERMS_MULTI_KEY]: "作品ごとに個別利用許諾番号を振る形（A4 横）。料率・期間が同じ作品を 1 枚にまとめる"
};

/** 一覧の行の欄。画面の行編集（LineItems の pub_titles）と本文が同じ名前を読む。 */
export const PUB_TITLES_FIELD = "pub_titles";

type Data = Record<string, any>;

const text = (value: unknown) => (value == null ? "" : String(value).trim());
const list = (value: unknown): Data[] =>
  Array.isArray(value) ? value.filter((x): x is Data => Boolean(x) && typeof x === "object") : [];
const number = (value: unknown): number | null => {
  if (value == null || String(value).trim() === "") return null;
  const parsed = Number.parseFloat(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
};
/** 料率の表記。小数は残す（8.5%）。無ければ「—」。 */
export const percentText = (value: unknown): string => {
  const n = number(value);
  return n == null ? "—" : `${+n.toFixed(2)}%`;
};

// ---------------------------------------------------------------------------
// ひな形の項目
// ---------------------------------------------------------------------------

/**
 * 契約単位の項目。一覧の外にあるもの。
 *
 * 期間・更新・地域・言語は条件明細から文案を作る（suggestions）。支払時期は
 * ひな形の既定値を入れておき、違う契約だけ人が直す。
 */
export const PUB_TERMS_VARIABLES: TemplateVariable[] = [
  { name: "条件書番号", label: "条件書番号", group: "I. 基本情報",
    dbField: "auto.docNumber", noGuess: true },
  { name: "締結日", label: "締結日", type: "date", group: "I. 基本情報", required: true,
    dbField: "auto.today", noGuess: true },
  { name: "基本契約番号", label: "基本契約番号", group: "I. 基本情報", from: "masterAgreement.no" },
  { name: "基本契約名", label: "基本契約名", group: "I. 基本情報", from: "masterAgreement.datedTitle" },
  { name: "署名欄", label: "署名欄（末尾の記名押印欄）", type: "select", options: ["表示する", "表示しない"],
    group: "I. 基本情報", noGuess: true, default: "表示する",
    helpText: "基本契約と一括で電子署名する場合は「表示しない」にすると、基本契約側の署名欄だけになります。" },

  { name: "許諾者名称", label: "許諾者（甲）名称", group: "II. 許諾者（甲）", required: true,
    from: "condition.counterparty.name" },
  { name: "許諾者住所", label: "許諾者（甲）住所", type: "textarea", group: "II. 許諾者（甲）",
    from: "condition.counterparty.address" },
  { name: "許諾者代表者名", label: "許諾者（甲）代表者名", group: "II. 許諾者（甲）",
    dbField: "vendor.vendor_rep_line", noGuess: true,
    helpText: "取引先の代表者の肩書と氏名（代表取締役 ◯◯）。個人の許諾者なら空のままでよい" },
  { name: "許諾者登録番号", label: "許諾者（甲）登録番号（T番号）", group: "II. 許諾者（甲）",
    from: "condition.counterparty.invoiceNo", helpText: "適格請求書発行事業者でなければ空のまま" },
  // 通知先は 部署 ／ 氏名 ／ メール ／ 電話 の 1 行。画面は 4 つの欄で編集する（type: contact）。
  { name: "許諾者連絡先", label: "許諾者（甲）通知先", type: "contact", group: "II. 許諾者（甲）",
    dbField: "vendor.contact_line", noGuess: true,
    helpText: "取引先の主担当（個人は本人）が入ります。違う人にするなら上書きする" },

  { name: "被許諾者名称", label: "被許諾者（乙）名称", group: "III. 被許諾者（乙）", required: true,
    from: "company.name" },
  { name: "被許諾者住所", label: "被許諾者（乙）住所", type: "textarea", group: "III. 被許諾者（乙）",
    from: "company.address" },
  { name: "被許諾者代表者名", label: "被許諾者（乙）代表者名", group: "III. 被許諾者（乙）",
    from: "company.rep" },
  { name: "被許諾者登録番号", label: "被許諾者（乙）登録番号（T番号）", group: "III. 被許諾者（乙）",
    from: "company.invoiceNo" },
  { name: "被許諾者連絡先", label: "被許諾者（乙）通知先", type: "contact", group: "III. 被許諾者（乙）",
    dbField: "staff.contact_line", noGuess: true,
    helpText: "案件の担当者（部署・氏名・メール・電話）が入ります。違う人にするなら上書きする" },

  { name: "許諾開始日", label: "許諾開始日", type: "date", group: "IV. 許諾期間・地域・言語", required: true,
    noGuess: true, helpText: "空なら条件明細の開始日のいちばん早い日" },
  { name: "許諾終了日", label: "許諾終了日", type: "date", group: "IV. 許諾期間・地域・言語",
    noGuess: true, helpText: "空なら条件明細の終了日のいちばん遅い日。どの条件にも無ければ期間の定めなし" },
  { name: "自動更新", label: "自動更新", type: "select", options: ["する", "しない"],
    group: "IV. 許諾期間・地域・言語", noGuess: true, default: "する" },
  // 既定（1年・1か月）は本文の側で補う。欄に既定を持たせると、決定のときの最初の束縛で既定が
  // 入り、条件の更新の単位（3年など）・契約の通知月数の文案が負けていた（一括で作った条件書）。
  { name: "更新期間", label: "更新の単位", group: "IV. 許諾期間・地域・言語", noGuess: true,
    helpText: "空なら条件の更新の単位（揃っていれば。3年など）、無ければ1年" },
  { name: "終了通知期限", label: "終了の通知期限（満了の何か月前）", group: "IV. 許諾期間・地域・言語",
    noGuess: true, helpText: "契約（合意）に更新通知の月数があればそれが入ります。無ければ1か月" },
  { name: "許諾地域", label: "許諾地域", type: "regions", group: "IV. 許諾期間・地域・言語", noGuess: true,
    helpText: "空なら条件明細の地域。どの条件にも無ければ全世界" },
  { name: "許諾言語", label: "許諾言語", type: "languages", group: "IV. 許諾期間・地域・言語", noGuess: true,
    helpText: "空なら条件明細の言語。どの条件にも無ければ日本語" },

  // 翻訳の立て付け（A-034）。同じ「翻訳版の出版」でも、相手によって
  // 「乙が窓口で再許諾する」と見るか「翻訳は二次的著作物だ」と見るかが違う。
  // 許諾料の計算（受領対価 × 料率）はどちらも同じで、条文の書き方だけが変わる。
  { name: "翻訳の扱い", label: "翻訳の扱い（条文の立て付け）", type: "select",
    options: ["再許諾", "二次的著作物"], group: "V. 許諾料・支払", noGuess: true, default: "再許諾",
    helpText: "「再許諾」＝乙が窓口として第三者に出させる書き方。「二次的著作物」＝翻訳権（著作権法27条）と28条の権利で書く書き方（取引先がこちらを求めるとき）。"
      + "許諾料はどちらも 受領する対価（税抜）× 料率 で変わりません。算定の細目は備考欄・特記事項に書きます" },
  { name: "翻訳物の在庫販売期間", label: "終了後に翻訳物の在庫を販売できる期間",
    group: "V. 許諾料・支払", noGuess: true, default: "6か月",
    helpText: "「翻訳の扱い」が二次的著作物のときだけ第３条に出ます" },
  { name: "翻訳版取り分", label: "翻訳版の許諾料（再許諾対価に対する %）", type: "number",
    group: "V. 許諾料・支払", noGuess: true,
    helpText: "翻訳版の条件明細があればそちらが使われます。条件明細が無いときだけ、この % で第４条を書きます" },
  { name: "紙の支払時期", label: "紙媒体の支払時期", group: "V. 許諾料・支払", noGuess: true,
    default: "翌月末日", helpText: "「刷部数確定の都度、◯◯までに支払う」の◯◯。紙の条件明細の支払条件から入る（変えるなら条件明細を直す）" },
  { name: "電子の集計期間", label: "電子書籍の集計期間", group: "V. 許諾料・支払", noGuess: true,
    default: "7月1日〜翌年6月30日", helpText: "電子の条件明細の支払条件から入る（変えるなら条件明細を直す）" },
  { name: "電子の支払時期", label: "電子書籍の支払時期", group: "V. 許諾料・支払", noGuess: true,
    default: "10月末日", helpText: "電子の条件明細の支払条件から入る（変えるなら条件明細を直す）" },
  { name: "翻訳版の支払時期", label: "翻訳版の支払時期", group: "V. 許諾料・支払", noGuess: true,
    default: "翌々月末日", helpText: "「乙が再許諾先から対価を受領した日の◯◯までに」の◯◯。翻訳版の条件明細の支払条件から入る" },

  { name: "特記事項", label: "特記事項", type: "textarea", group: "VI. 特記事項", noGuess: true,
    default: "本条件書は電子署名により締結し、電磁的記録をもって原本とする。" },

  // 一覧そのもの。画面は行の編集欄を出すので、手入力の項目一覧には並べない。
  { name: PUB_TITLES_FIELD, label: "対象著作物", type: "array", group: "VII. 対象著作物" }
];

// ---------------------------------------------------------------------------
// 一覧の行（条件明細から組む）
// ---------------------------------------------------------------------------

/** 条件1本の媒体。利用形態（A-027）が先、無ければ範囲の media から。 */
export const mediaOfCondition = (condition: Data): PubMedia | null =>
  pubMediaOfUsage(condition?.usageType) ?? pubMediaOfScopes(condition?.scopes?.media);

/**
 * 条件明細の支払条件から、条件書の支払の表に入る語を読む。
 *
 * 条件書の表は「毎年{集計期間}を集計期間とし、{支払時期}までに支払う。」（電子）、
 * 「刷部数確定の都度、{支払時期}までに支払う。」（紙）、「再許諾先から対価を受領した日の
 * {支払時期}までに」（翻訳版）。条件明細の支払条件は計算書の回と支払期日が読む文なので、
 * 紙面はそこから写す（別々に持つと、紙面と実際に回す時期が食い違う）。
 * 読めない書き方なら null（画面の欄に任せ、警告を出す）。
 */
export interface PubPaymentTerms { period?: string; pay?: string }
const MONTH_DAY = /(翌々?月|当月|\d{1,2}月)(末日|\d{1,2}日)/;
export function readPubPaymentTerms(terms: unknown, media: "print" | "digital" | "translation"): PubPaymentTerms | null {
  const s = text(terms).normalize("NFKC").replace(/\s+/g, "").replace(/~|～/g, "〜");
  if (!s) return null;
  if (media === "digital") {
    // 集計期間は 1 つ（年 1 回）でも複数（年 2 回・年 4 回。「及び」「、」でつなぐ）でもよい。
    const at = s.indexOf("を集計期間とし");
    if (at < 0) return null;
    const head = s.slice(0, at);
    const period = head.includes("毎年") ? head.slice(head.lastIndexOf("毎年") + 2) : head;
    if (!/^\d{1,2}月\d{1,2}日〜/.test(period)) return null;
    const pay = /^[、,]?(.+?)まで(?:に)?支払/.exec(s.slice(at + "を集計期間とし".length));
    return pay ? { period, pay: pay[1] } : null;
  }
  const explicit = /(?:都度|受領した日の)[、,]?(.+?)まで(?:に)?支払/.exec(s);
  if (explicit) return { pay: explicit[1] };
  const m = MONTH_DAY.exec(s);
  return m ? { pay: `${m[1]}${m[2]}` } : null;
}

/**
 * 載っている条件の支払条件から、紙・電子・翻訳版それぞれの語を 1 つに決める。
 * 同じ媒体で読めた語が食い違えば、いちばん多いもの（同数なら先の条件）を使い、食い違いを返す。
 */
export function pubPaymentFromConditions(conditions: Data[]): {
  payPrint?: string; digitalPeriod?: string; payDigital?: string; payTranslation?: string;
  unreadable: string[]; conflicts: string[];
} {
  const out: ReturnType<typeof pubPaymentFromConditions> = { unreadable: [], conflicts: [] };
  const buckets: Record<string, Array<{ no: string; value: string }>> = { payPrint: [], digitalPeriod: [], payDigital: [], payTranslation: [] };
  for (const c of conditions) {
    const media = mediaOfCondition(c);
    if (!media) continue;
    const kind = isTranslationCondition(c) ? "translation" : media === "digital" ? "digital" : "print";
    const raw = text(c.paymentTerms);
    if (!raw) continue;
    const read = readPubPaymentTerms(raw, kind);
    const no = text(c.conditionNo) || `#${c.id}`;
    if (!read) { out.unreadable.push(`${no}（${raw}）`); continue; }
    if (kind === "digital") {
      if (read.period) buckets.digitalPeriod.push({ no, value: read.period });
      if (read.pay) buckets.payDigital.push({ no, value: read.pay });
    } else if (read.pay) {
      buckets[kind === "print" ? "payPrint" : "payTranslation"].push({ no, value: read.pay });
    }
  }
  const label: Record<string, string> = { payPrint: "紙の支払時期", digitalPeriod: "電子の集計期間", payDigital: "電子の支払時期", payTranslation: "翻訳版の支払時期" };
  for (const [key, rows] of Object.entries(buckets)) {
    if (!rows.length) continue;
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.value, (counts.get(r.value) ?? 0) + 1);
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    (out as Record<string, unknown>)[key] = best;
    if (counts.size > 1) {
      out.conflicts.push(`${label[key]}が条件明細ごとに違います（${rows.map((r) => `${r.no}：${r.value}`).join("、")}）。紙面は「${best}」で出ます`);
    }
  }
  return out;
}

/** 翻訳版の再許諾か（A-033）。自社出版の紙・電子と分けて畳む。 */
export const isTranslationCondition = (condition: Data): boolean =>
  isSublicensingUsage(condition?.usageType);

/**
 * 再許諾の別途合意（A-033）。空は「要」扱い（黙って包括許諾にしない）。
 * 条件書の条文と一覧の印がこれで出し分かれる。
 */
export const consentLabel = (value: unknown): "不要" | "要" =>
  String(value ?? "") === "covered" ? "不要" : "要";

const exclusivityText = (condition: Data | undefined): string =>
  condition ? text(condition.exclusivityLabel
    ?? (condition.exclusivity === "exclusive" ? "独占"
      : condition.exclusivity === "non_exclusive" ? "非独占" : "")) : "";

/**
 * 作品でまとめる鍵。作品が無い条件（移行分にある）は名前でまとめる。
 * 作品も名前も違えば別の行。
 */
const titleKeyOf = (condition: Data): string =>
  condition.workId != null ? `work:${condition.workId}` : `name:${text(condition.name)}`;

/** 行に載せられる条件か。載せられない理由を返す（null なら載せられる）。 */
export function rowBlockerOf(condition: Data): string | null {
  const no = text(condition.conditionNo) || `#${condition.id}`;
  if (text(condition.pricingModel) !== "revenue_rate" || number(condition.ratePct) == null) {
    return `${no}：計算方式が料率ではありません（出版の許諾料は 定価×部数×料率 で固定です）`;
  }
  if (!mediaOfCondition(condition)) {
    return `${no}：利用形態（出版・紙／出版・電子）が入っていません。条件の編集で利用形態を選んでください`;
  }
  return null;
}

/**
 * 一覧の種。作品1点が1行。紙の条件と電子の条件を同じ行に畳む。
 *
 * 行に載せる文字（著作権表示・共同著作・備考）は条件明細に置き場所が無い
 * ので、備考だけ条件の備考から写し、あとは人が行で入れる。直した行は
 * manualInputs の pub_titles に残る。
 */
/** 今日（YYYY-MM-DD）。更新の回数を数える既定の基準日。 */
const todayStr = () => new Date().toISOString().slice(0, 10);

/**
 * 増刷時の非加算（2 版目以降の非加算。紙の条件の royalty_exempt_later_pct）の備考の 1 文。
 * 第４条は「印税対象部数は刷部数」としか言わないので、係数のある作品は一覧の備考で言う（旧契約の係数の引き継ぎ）。
 */
export const EXEMPT_NOTE_HEAD = "増刷時の印税対象部数は";
export function exemptLaterNote(pct: number | null | undefined): string {
  if (pct === null || pct === undefined || !(pct > 0)) return "";
  const rate = Number((100 - pct).toFixed(4));
  return `${EXEMPT_NOTE_HEAD}刷部数の${rate}%（非加算 ${Number(pct.toFixed(4))}%）`;
}

/** 電子の料率の基準が乙の入金額（受領額）の作品に添える備考の 1 文（第４条がこれを指す）。 */
export const RECEIPTS_NOTE = "電子の料率は乙の入金額に対する率";

/**
 * 条件の許諾期間の終期（自動更新を基準日まで数えた、いまの期間の終わり）の最大。
 * 第３条の「許諾期間 … 〜 終期」は作品ごとの期間の外包みなので、更新前の終了日の最大では
 * 一覧の終期（更新後）より早い日が出る。
 */
export function latestRenewedEnd(conditions: Data[], asOf: string): string {
  return conditions.map((c) => {
    if (!text(c.termEnd)) return "";
    return renewalOf({
      termStart: text(c.termStart) || null, termEnd: text(c.termEnd) || null,
      autoRenew: c.autoRenew === true, renewMonths: number(c.renewMonths),
      renewStoppedOn: text(c.renewStoppedOn) || null
    }, asOf).currentEnd ?? "";
  }).filter(Boolean).sort().at(-1) ?? "";
}

/** 百万分率を %（小数 4 桁まで、末尾の 0 なし）に。 */
const ppmPct = (ppm: number) => String(Number((ppm / 10000).toFixed(4)));

/** 共同著作の取り分の文（「作家B 66.67%・作家C 33.33%」。代表が分配なら頭に付す）。取り分が無ければ空。 */
export function sharesText(condition: Data | null | undefined): string {
  const shares = list(condition?.shares);
  if (!shares.length) return "";
  const body = shares.map((s) => `${text(s.name)} ${ppmPct(number(s.sharePpm) ?? 0)}%`).join("・");
  return `${text(condition?.distribution) === "representative" ? "代表が分配：" : ""}${body}`;
}

/**
 * 同じ作品の紙と電子で、取り分の有無や中身が食い違う作品を名指しする（受取人宛ての料率が揃わない原因）。
 */
export function sharesMismatch(conditions: Data[]): string[] {
  const groups = new Map<string, Data[]>();
  for (const c of conditions) {
    if (rowBlockerOf(c) || isTranslationCondition(c)) continue;
    const key = titleKeyOf(c);
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const out: string[] = [];
  for (const group of groups.values()) {
    const print = group.find((c) => mediaOfCondition(c) === "print");
    const digital = group.find((c) => mediaOfCondition(c) === "digital");
    if (!print || !digital) continue;
    const title = text(print.work?.title) || text(print.name);
    const np = list(print.shares).length, nd = list(digital.shares).length;
    if (np && !nd) out.push(`作品「${title}」は紙（${text(print.conditionNo) || `#${print.id}`}）に取り分があるのに電子（${text(digital.conditionNo) || `#${digital.id}`}）にはありません。電子の料率は全体の率のまま出ます。電子の条件明細にも同じ取り分を入れてください`);
    else if (!np && nd) out.push(`作品「${title}」は電子（${text(digital.conditionNo) || `#${digital.id}`}）に取り分があるのに紙（${text(print.conditionNo) || `#${print.id}`}）にはありません。紙の料率は全体の率のまま出ます。紙の条件明細にも同じ取り分を入れてください`);
    else if (np && nd && !sameSharesOf(print, digital)) out.push(`作品「${title}」は紙と電子で取り分が違います（紙：${sharesText(print)}／電子：${sharesText(digital)}）。意図したものでなければ揃えてください`);
  }
  return out;
}

/** 紙・電子で同じ按分か。 */
function sameSharesOf(a: Data | undefined, b: Data | undefined): boolean {
  const key = (c: Data | undefined) => list(c?.shares).map((s) => `${number(s.partyId)}:${number(s.sharePpm)}`).sort().join("|");
  return key(a) === key(b);
}

/** 紙と電子の両方の取り分。同じなら 1 つ、違えば「紙：…／電子：…」。 */
export function mediaSharesText(print: Data | undefined, digital: Data | undefined): string {
  if (print && digital && list(print.shares).length && list(digital.shares).length && !sameSharesOf(print, digital)) {
    return `紙：${sharesText(print)}／電子：${sharesText(digital)}`;
  }
  return sharesText(digital ?? print);
}

/** 受取人（甲）の取り分（百万分率）。その条件の取り分に入っていなければ null。 */
function payeeShareOf(payee: Data | null | undefined, condition: Data | undefined): number | null {
  const partyId = number(payee?.partyId);
  if (partyId == null || !condition) return null;
  const share = list(condition.shares).find((s) => number(s.partyId) === partyId);
  return share ? number(share.sharePpm) ?? null : null;
}

/**
 * 受取人（甲）の取り分の文（「甲の取り分 25%」）。一覧の「共同著作」欄に添える。
 * 媒体ごとの率は料率の欄（payeeRateText）に出すので、ここでは繰り返さない。受取人でなければ空。
 */
export function payeeShareText(payee: Data | null | undefined, print: Data | undefined, digital: Data | undefined): string {
  const p = payeeShareOf(payee, print);
  const d = payeeShareOf(payee, digital);
  if (p != null && d != null && p !== d) return `甲の取り分 紙 ${ppmPct(p)}%・電子 ${ppmPct(d)}%`;
  const ppm = d ?? p;
  return ppm == null ? "" : `甲の取り分 ${ppmPct(ppm)}%`;
}

/**
 * 受取人（甲）宛ての料率の欄。甲に帰属する率を主にし、括弧で対象著作物全体の料率を添える
 * （「2.5%（全体 10%）」）。全体の率だけを出すと、一覧の合計許諾料と読み違える。
 * 受取人でないか、その条件の取り分に入っていなければ全体の率そのもの。
 */
export function payeeRateText(payee: Data | null | undefined, condition: Data | undefined): string {
  if (!condition) return "—";
  const whole = number(condition.ratePct);
  if (whole == null) return "—";
  const ppm = payeeShareOf(payee, condition);
  if (ppm == null) return percentText(whole);
  return `${ppmPct(Math.round((whole * ppm) / 100))}%（全体 ${percentText(whole)}）`;
}

export function pubTitleSeeds(context: Data): Data[] {
  const groups = new Map<string, Data[]>();
  for (const condition of list(context.conditions)) {
    if (rowBlockerOf(condition)) continue;
    const key = titleKeyOf(condition);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(condition);
  }
  return [...groups.values()].map((group) => {
    const own = group.filter((c) => !isTranslationCondition(c));
    const trans = group.filter((c) => isTranslationCondition(c));
    const print = own.find((c) => mediaOfCondition(c) === "print");
    const digital = own.find((c) => mediaOfCondition(c) === "digital");
    // 翻訳版の再許諾（A-033）。紙・電子で率が違うので別々に持つ。
    const transPrint = trans.find((c) => mediaOfCondition(c) === "print");
    const transDigital = trans.find((c) => mediaOfCondition(c) === "digital");
    const head = print ?? digital ?? transPrint ?? transDigital ?? group[0];
    const title = text(head.work?.title) || text(head.name);
    // 対象出版物名は条件名。作品名と同じか、規則どおりの「作品名｜取引モデル」
    // なら空にして、紙に二重に出さない（規則名は台帳の都合で、出版物名ではない）。
    const name = text(head.name);
    const edition = name === title || name.startsWith(`${title}｜`) ? "" : name;
    // 初版分を発注書の報酬で払った作品（A-077/A-089）：条件の備考に書いていなくても、備考に 1 文を写す。
    const paid = [print, digital].find((c) => c && String(c.licenseFeeBasis) === "in_lieu");
    const paidNote = paid ? inLieuPaidNote({ price: paid.firstEditionPrice, copies: paid.firstEditionCopies,
                                             ratePct: paid.firstEditionRatePct, exemptCopies: paid.royaltyExemptFirstCopies }) : "";
    const exemptNote = exemptLaterNote(number(print?.royaltyExemptLaterPct));
    const receiptsNote = digital && String(digital.priceBasis) === "receipts" ? RECEIPTS_NOTE : "";
    const notes = [...new Set([paidNote, exemptNote, receiptsNote, ...group.map((c) => text(c.notes))].filter(Boolean))].join("／");
    return {
      item_name: title,
      title,
      edition,
      // 作品に持たせた著作権表示・第三者権利（A-027）。無ければ行で人が入れる。
      copyright: text(head.work?.copyrightNotice),
      // 作品の個別契約の番号（作品ごとに番号を持つ条件書の「条件書番号」欄）。紙・電子のどちらかが載っている個別契約。
      terms_no: text(print?.termsAgreementNo) || text(digital?.termsAgreementNo) || text(head.termsAgreementNo),
      third_party: text(head.work?.thirdPartyRights),
      // 共同著作の取り分（A-068）。条件明細の写し。条件から出た行は紙に出すとき引き直す。
      co_authors: print || digital ? mediaSharesText(print, digital) : sharesText(head),
      note: notes,
      print_rate: print ? percentText(print.ratePct) : "—",
      print_exclusivity: print ? exclusivityText(print) || "—" : "—",
      digital_rate: digital ? percentText(digital.ratePct) : "—",
      digital_exclusivity: digital ? exclusivityText(digital) || "—" : "—",
      trans_print_rate: transPrint ? percentText(transPrint.ratePct) : "",
      trans_digital_rate: transDigital ? percentText(transDigital.ratePct) : "",
      // 別途合意の要否。紙と電子で違えば、要のほうに寄せる（厳しいほうで書く）。
      trans_consent: trans.length
        ? (trans.some((c) => consentLabel(c.sublicenseConsent) === "要") ? "要" : "不要") : "",
      // 許諾期間と自動更新（A-039）。期間は作品ごとに違うので一覧に出す。
      // 行を直したときは、この文字がそのまま紙に出る（条件を直すのが本筋）。
      term_label: renewalLabel({
        termStart: text(head.termStart) || null, termEnd: text(head.termEnd) || null,
        autoRenew: head.autoRenew === true,
        renewMonths: number(head.renewMonths), renewStoppedOn: text(head.renewStoppedOn) || null
      }, todayStr()),
      print_condition_id: print?.id ?? null,
      digital_condition_id: digital?.id ?? null,
      trans_print_condition_id: transPrint?.id ?? null,
      trans_digital_condition_id: transDigital?.id ?? null,
      // 手で足した行と見分ける。条件から出た行は料率を条件から引き直す。
      condition_ids: group.map((c) => c.id)
    };
  });
}

/**
 * 決定する前に見せる警告。
 *
 * 載せられない条件（料率でない・媒体が無い）は黙って落とさず名指しする。
 * 同じ作品に紙が2本あるのも同じ（どちらの料率を載せるか決められない）。
 */
export function pubTermsWarnings(context: Data, templateKey: string = PUB_TERMS_KEY): Warning[] {
  const out: Warning[] = [];
  const conditions = list(context.conditions);
  // 支払の表は条件明細の支払条件から写す。読めない書き方・食い違いは紙面の前に知らせる。
  const payment = pubPaymentFromConditions(conditions);
  for (const u of payment.unreadable) {
    out.push({ kind: "other", message: `条件明細の支払条件から支払の表の語を読めません：${u}。紙面は画面の欄（空なら既定）で出ます。条件明細の支払条件を「毎年7月1日〜翌年6月30日を集計期間とし、10月末日までに支払う。」の形にすると連動します` });
  }
  for (const c of payment.conflicts) out.push({ kind: "other", message: c });
  for (const condition of conditions) {
    const blocker = rowBlockerOf(condition);
    if (blocker) out.push({ kind: "other", message: `一覧に載せられない条件明細 ${blocker}` });
  }
  const seen = new Map<string, number>();
  for (const condition of conditions) {
    if (rowBlockerOf(condition)) continue;
    // 自社出版と翻訳版は別の枠。紙出版と翻訳版（紙）が1本ずつあるのは重複ではない。
    const key = `${titleKeyOf(condition)}／${isTranslationCondition(condition) ? "trans" : "own"}／${mediaOfCondition(condition)}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const [key, count] of seen) {
    if (count > 1) {
      const media = `${key.includes("／trans／") ? "翻訳版の" : ""}${key.endsWith("print") ? "紙" : "電子"}`;
      const first = conditions.find((c) =>
        `${titleKeyOf(c)}／${isTranslationCondition(c) ? "trans" : "own"}／${mediaOfCondition(c)}` === key);
      out.push({ kind: "other",
        message: `同じ作品「${text(first?.work?.title) || text(first?.name)}」に${media}の条件が${count}本あります。1本にしてください` });
    }
  }
  const parties = new Set(conditions.map((c) => c.counterpartyId).filter((v) => v != null));
  if (parties.size > 1) {
    out.push({ kind: "other", message: "相手先の違う条件明細が混ざっています。条件書は許諾者1者につき1枚です" });
  }
  // 取り分（共著）は条件ごとに持つので、同じ作品の紙と電子で片方にしか無いことがある。
  // 受取人宛てだと、取り分の無い側は「2%（全体 10%）」にならず全体の率のまま出る（受取人がその条件の相手先なら載る）。
  // 黙って出さず名指しする。直すのは条件明細の取り分（紙・電子の両方に同じ取り分を入れる）。
  for (const w of sharesMismatch(conditions)) out.push({ kind: "other", message: w });
  // どちらのひな形で出すか。作品が多いのに一覧を前に置くと、条文が何ページも
  // 後ろに行く。逆に数点で別紙にすると、1点のために別紙が1枚増える。
  const count = pubTitleSeeds(context).length;
  if (!isPubTermsAnnex(templateKey) && count > PUB_TITLES_ANNEX_HINT) {
    out.push({ kind: "other",
      message: `対象の作品が ${count} 点あります。一覧が条文の前に何ページも続くので、`
             + "ひな形を「出版等利用許諾条件書（V3・別紙形式）」にすると読みやすくなります" });
  }
  if (isPubTermsAnnex(templateKey) && count > 0 && count <= 3) {
    out.push({ kind: "other",
      message: `対象の作品が ${count} 点です。別紙にするほどの量ではないので、`
             + "ひな形を「出版等利用許諾条件書（V3・一覧形式）」にすると1枚に収まります" });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 契約単位の文案（条件明細から）
// ---------------------------------------------------------------------------

const scopeLabels = (context: Data, type: "region" | "language"): string => {
  const labels: string[] = [];
  for (const condition of list(context.conditions)) {
    for (const label of (condition?.scopes?.[type] ?? []) as string[]) {
      const value = text(label);
      if (value && !labels.includes(value)) labels.push(value);
    }
  }
  return labels.join("、");
};

const minDate = (values: string[]) => values.filter(Boolean).sort()[0] ?? "";
const maxDate = (values: string[]) => values.filter(Boolean).sort().at(-1) ?? "";

/**
 * 期間・更新・地域・言語の文案。人が直せる（手入力が勝つ）。
 * 期間は条件明細の期間の外包み。更新の通知期限は契約（合意）から。
 */
export function pubTermsSuggestions(context: Data, _bound: Data = {}): Data {
  const out: Data = {};
  const conditions = list(context.conditions);
  const start = minDate(conditions.map((c) => text(c.termStart)));
  // 終期は自動更新を今日まで数えた、いまの期間の終わりの最大（一覧の終期と揃える）。
  const end = latestRenewedEnd(conditions, todayStr()) || maxDate(conditions.map((c) => text(c.termEnd)));
  if (start) out["許諾開始日"] = start;
  if (end) out["許諾終了日"] = end;
  const region = scopeLabels(context, "region");
  const language = scopeLabels(context, "language");
  if (region) out["許諾地域"] = region;
  if (language) out["許諾言語"] = language;
  // 自動更新・通知期限は基本契約の定め（無ければ条件の契約そのもの）。個別契約の行には無い。
  const governing = contextMasterAgreement(context) ?? context.agreement;
  if (governing && typeof governing.autoRenewal === "boolean") {
    out["自動更新"] = governing.autoRenewal ? "する" : "しない";
  }
  const months = number(governing?.renewalNoticeMonths);
  if (months) out["終了通知期限"] = `${months}か月`;
  const unit = renewUnitOf(conditions);
  if (unit) out["更新期間"] = unit;
  return out;
}

/** 契約（合意）の更新通知の月数。「3か月」。 */
const noticeOf = (context: Data): string => {
  const months = number((contextMasterAgreement(context) ?? context.agreement)?.renewalNoticeMonths);
  return months ? `${months}か月` : "";
};

/**
 * 条件の更新の単位（自動更新する条件がみな同じ単位のときだけ）。36 か月なら「3年」。
 * 許諾期間を入れ直した条件（3 年・3 年ごとに更新）の条件書で、第３条の更新の行が
 * 既定の「1年」のままにならないように。単位が揃っていなければ空（欄の値か既定）。
 */
export function renewUnitOf(conditions: Data[]): string {
  const units = [...new Set(conditions
    .filter((c) => c.autoRenew === true && text(c.termEnd))
    .map((c) => number(c.renewMonths) ?? 12))];
  if (units.length !== 1) return "";
  const months = units[0]!;
  return months % 12 === 0 ? `${months / 12}年` : `${months}か月`;
}

// ---------------------------------------------------------------------------
// 本文の文脈
// ---------------------------------------------------------------------------

const joinContact = (parts: unknown[]) =>
  parts.map((v) => text(v)).filter(Boolean).join(" ／ ");

/**
 * 本文に渡す値。項目（bound）→ 手入力（manual）→ 文脈 の順で見る。
 * 一覧の行は、人が直した行があればそれ、無ければ種。条件から出た行の料率と
 * 独占区分は、行を直していても条件から引き直す（紙は台帳の写し。料率を
 * 変えるなら条件を直す）。
 */
export function pubTermsPatch(context: Data, manual: Data = {}): Data {
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const value = manual[key] ?? context[key];
      if (value != null && String(value).trim() !== "") return String(value).trim();
    }
    return "";
  };
  const conditions = list(context.conditions);
  const payment = pubPaymentFromConditions(conditions);
  // 載っている媒体。無い媒体の支払の行は「—」にする（A-107）。
  const hasPrintMedia = conditions.some((c) => mediaOfCondition(c) === "print");
  const hasDigitalMedia = conditions.some((c) => mediaOfCondition(c) === "digital");
  const digitalConds = conditions.filter((c) => mediaOfCondition(c) === "digital" && !isTranslationCondition(c));
  const byId = new Map(conditions.map((c) => [Number(c.id), c]));
  const seeds = pubTitleSeeds(context);
  const rows = list(manual[PUB_TITLES_FIELD]).length ? list(manual[PUB_TITLES_FIELD]) : seeds;

  // 翻訳の立て付け（A-034）。一覧の行の見出しにも条文にも同じ語を使うので、
  // 行を組む前に決めておく（each の中からは外側の値が見えない）。
  // 更新の回数を数える基準日。締結日（下書きは今日）。決定した文書は値を
  // 保存するので、あとから回数が増えても過去の紙は変わらない。
  const asOf = pick("締結日") || text(context.document?.issuedOn) || todayStr();
  const translationDerivative = pick("翻訳の扱い") === "二次的著作物";
  const translationLabel = translationDerivative ? "翻訳版" : "翻訳版再許諾";

  // 行に控えた条件 id が、いまの条件に無いことがある（条件を改訂した・重複を無効にして新しい方に付け替えた）。
  // そのときは同じ作品（題名）の種の行から引き直す。引けないと、行に書いてある古い料率・独占区分が紙に出続ける。
  const seedByTitle = new Map(seeds.map((seed) => [text(seed.title) || text(seed.item_name), seed]));
  const resolve = (row: Data, key: string): Data | undefined => {
    const direct = row[key] != null ? byId.get(Number(row[key])) : undefined;
    if (direct) return direct;
    const seed = seedByTitle.get(text(row.title) || text(row.item_name));
    return seed && seed[key] != null ? byId.get(Number(seed[key])) : undefined;
  };
  const titles = rows.map((row, index) => {
    const print = resolve(row, "print_condition_id");
    const digital = resolve(row, "digital_condition_id");
    const transPrint = resolve(row, "trans_print_condition_id");
    const transDigital = resolve(row, "trans_digital_condition_id");
    const fromLedger = Boolean(print || digital || transPrint || transDigital);
    // 翻訳版は「紙 50%／電子 40%」のように1つの欄にまとめる。列を2つ足すと
    // A4 縦に収まらない。片方だけの作品はその媒体だけ出す。
    const transPrintRate = transPrint ? percentText(transPrint.ratePct) : text(row.trans_print_rate);
    const transDigitalRate = transDigital ? percentText(transDigital.ratePct) : text(row.trans_digital_rate);
    const transText = [transPrintRate ? `紙 ${transPrintRate}` : "",
                       transDigitalRate ? `電子 ${transDigitalRate}` : ""].filter(Boolean).join("／");
    // 許諾期間は自社出版の条件から引く（紙→電子→翻訳版の順）。行を直して
    // いても条件があればそちらが正。条件が無い行は書いてある文字をそのまま出す。
    const termHead = print ?? digital ?? transPrint ?? transDigital;
    const termLabel = termHead
      ? renewalLabel({
          termStart: text(termHead.termStart) || null, termEnd: text(termHead.termEnd) || null,
          autoRenew: termHead.autoRenew === true,
          renewMonths: number(termHead.renewMonths),
          renewStoppedOn: text(termHead.renewStoppedOn) || null
        }, asOf)
      : text(row.term_label);
    const transConsent = (transPrint || transDigital)
      ? ([transPrint, transDigital].filter(Boolean).some((c) => consentLabel(c!.sublicenseConsent) === "要") ? "要" : "不要")
      : text(row.trans_consent);
    // 共同著作の取り分。条件から出た行は条件の取り分（受取人宛てならその人の取り分も）。
    const coAuthors = fromLedger ? (print || digital ? mediaSharesText(print, digital) : sharesText(termHead)) : text(row.co_authors);
    const payeeShare = fromLedger ? payeeShareText(context.payee, print, digital) : "";
    // 備考のうち「初版分は支払済み（算定：…）」の自動の 1 文は、行を直していても条件から引き直す（A-109）。
    // 人が備考に書いた残りはそのまま。料率・独占区分と同じく、台帳の写しは台帳が正。
    const note = (() => {
      const typed = text(row.note).split("／").map((s) => s.trim()).filter(Boolean)
        .filter((s) => !s.startsWith("初版の出版に係る利用許諾料は") && !s.startsWith(EXEMPT_NOTE_HEAD) && s !== RECEIPTS_NOTE);
      const paidCond = fromLedger ? [print, digital].find((c) => c && String(c.licenseFeeBasis) === "in_lieu") : null;
      const fresh = paidCond ? inLieuPaidNote({ price: paidCond.firstEditionPrice, copies: paidCond.firstEditionCopies,
                                               ratePct: paidCond.firstEditionRatePct, exemptCopies: paidCond.royaltyExemptFirstCopies,
                                               priceBasis: paidCond.priceBasis, partyName: paidCond.targetPartyName }) : "";
      // 増刷時の非加算と電子の料率の基準も台帳から引き直す（行を直していてもそちらが正）。
      const exempt = fromLedger ? exemptLaterNote(number(print?.royaltyExemptLaterPct)) : "";
      const receipts = fromLedger && digital && String(digital.priceBasis) === "receipts" ? RECEIPTS_NOTE : "";
      return [fresh, exempt, receipts, ...typed].filter(Boolean).join("／");
    })();
    // 作品の個別契約の番号。条件から出た行は条件の個別契約が正（決定のときに作品ごとに立てる）。
    const termsNo = (fromLedger ? text(print?.termsAgreementNo) || text(digital?.termsAgreementNo)
      || text(transPrint?.termsAgreementNo) || text(transDigital?.termsAgreementNo) : "") || text(row.terms_no);
    return {
      no: index + 1,
      termsNo,
      title: text(row.title) || text(row.item_name),
      edition: text(row.edition),
      copyright: text(row.copyright),
      thirdParty: text(row.third_party) || "なし",
      note,
      coAuthors, payeeShare, hasShares: Boolean(coAuthors),
      // 「共同著作・第三者権利」欄（作品ごとに番号を持つ条件書）。共著の取り分か第三者権利があれば「あり」。
      jointLabel: Boolean(coAuthors) || (text(row.third_party) !== "" && text(row.third_party) !== "なし") ? "あり" : "なし",
      printRate: fromLedger ? payeeRateText(context.payee, print) : (text(row.print_rate) || "—"),
      printExclusivity: fromLedger ? (print ? exclusivityText(print) || "—" : "—")
        : (text(row.print_exclusivity) || "—"),
      digitalRate: fromLedger ? payeeRateText(context.payee, digital) : (text(row.digital_rate) || "—"),
      digitalExclusivity: fromLedger ? (digital ? exclusivityText(digital) || "—" : "—")
        : (text(row.digital_exclusivity) || "—"),
      hasPrint: fromLedger ? Boolean(print) : text(row.print_rate) !== "" && text(row.print_rate) !== "—",
      hasDigital: fromLedger ? Boolean(digital) : text(row.digital_rate) !== "" && text(row.digital_rate) !== "—",
      // 翻訳版の再許諾（A-033）。紙・電子の率を1つにまとめ、別途合意の要否を添える。
      // 作品ごとに率が違うので、条文ではなく一覧で持つ。列にすると紙・電子・要否の
      // 3行を 22mm に押し込むことになるので、備考と同じ全幅の行に1文で出す（A-035）。
      translation: transText || "—",
      hasTranslation: Boolean(transText),
      translationConsent: transConsent,
      // 「要」の作品が1点でもあれば、条文は個別合意が要る側で書く。
      translationConsentRequired: transConsent === "要",
      // 許諾期間と更新（A-039）。条件から引き直す（行を直していてもそちらが正）。
      term: termLabel,
      hasTerm: Boolean(termLabel),
      // 作品の下に続ける行（許諾期間・翻訳版・共同著作・備考）を出すか。
      hasNoteRow: Boolean(termLabel) || Boolean(transText) || Boolean(coAuthors) || text(row.note) !== "",
      translationLabel, translationDerivative
    };
  });

  // 翻訳版の条件がある作品。別途合意の要否は、この中だけで数える。
  const transTitles = titles.filter((t) => t.hasTranslation);
  const counterparty = context.condition?.counterparty ?? {};
  const primaryContact = list(context.contacts).find((c) => c.role === "primary") ?? {};
  const translationShare = number(pick("翻訳版取り分"));
  const autoRenew = pick("自動更新") !== "しない";
  const bank = context.bank ?? null;

  return {
    docNo: pick("条件書番号") || text(context.document?.number),
    signDate: pick("締結日") || text(context.document?.issuedOn),
    agreementNo: pick("基本契約番号") || text(contextMasterAgreement(context)?.no),
    agreementTitle: pick("基本契約名")
      || text(contextMasterAgreement(context)?.datedTitle ?? contextMasterAgreement(context)?.title)
      || "出版等利用許諾基本契約書",
    showSignature: pick("署名欄") !== "表示しない",
    /** 受取人（共著者の一人）宛ての条件書（A-068）。本文に取り分の一文が入る。 */
    payeeTerms: number(context.payee?.partyId) != null,
    payeeName: text(context.payee?.name),

    licensorName: pick("許諾者名称") || text(counterparty.name),
    licensorAddress: pick("許諾者住所") || text(counterparty.address),
    licensorRep: pick("許諾者代表者名"),
    licensorInvoiceNo: pick("許諾者登録番号") || text(counterparty.invoiceNo),
    licensorIsCorp: text(counterparty.kind) !== "individual",
    // 取引先の主担当（個人は本人）。A-032 で取引先が持つようになった。
    licensorContact: pick("許諾者連絡先")
      || joinContact([primaryContact.department, primaryContact.name, primaryContact.email, primaryContact.phone]),
    /** 源泉徴収。取引先の設定（個人はふつう対象）。本文の固定文言が出し分ける。 */
    withholding: counterparty.withholding === true,

    licenseeName: pick("被許諾者名称") || text(context.company?.name),
    licenseeAddress: pick("被許諾者住所") || text(context.company?.address),
    licenseeRep: pick("被許諾者代表者名") || text(context.company?.rep ?? context.company?.representative),
    licenseeInvoiceNo: pick("被許諾者登録番号") || text(context.company?.invoiceNo),
    // 乙（当社）の通知先：欄 → 案件の担当者 → 自社の設定（担当部署・代表メール・電話）。空のまま出さない。
    licenseeContact: pick("被許諾者連絡先")
      || joinContact([context.owner?.department, context.owner?.name, context.owner?.email, context.owner?.phone])
      || joinContact([context.company?.department ?? context.company?.contactDepartment, context.company?.contactName ?? context.company?.contact,
                      context.company?.email ?? context.company?.contactEmail, context.company?.tel ?? context.company?.phone]),

    // 欄が空なら条件明細の期間の外包み（文案と同じ規則）。空の期間を紙に出さない。
    termStart: pick("許諾開始日") || minDate(conditions.map((c) => text(c.termStart))),
    termEnd: pick("許諾終了日") || latestRenewedEnd(conditions, asOf) || maxDate(conditions.map((c) => text(c.termEnd))),
    autoRenew,
    renewPeriod: pick("更新期間") || renewUnitOf(conditions) || "1年",
    noticeBefore: pick("終了通知期限") || noticeOf(context) || "1か月",
    region: pick("許諾地域") || "全世界",
    language: pick("許諾言語") || "日本語",

    // 翻訳版（A-033）。条件明細があればそちらが本体。作品ごとに率が違うので
    // 条文には率を書かず、一覧の「翻訳版」欄を指す。条件が無いときだけ、
    // これまでどおり手入力の取り分（1枚に1つ）で書く。
    hasTranslationConditions: transTitles.length > 0,
    translationConsentRequired: transTitles.some((t) => t.translationConsentRequired),
    translationConsentAllCovered: transTitles.length > 0
      && !transTitles.some((t) => t.translationConsentRequired),
    // 要と不要が混ざる（作品ごとに違う）。条文は一覧の欄を指して書き分ける。
    translationConsentMixed: transTitles.some((t) => t.translationConsentRequired)
      && transTitles.some((t) => !t.translationConsentRequired),
    hasTranslation: translationShare != null || transTitles.length > 0,
    // 第５条の支払の行の枠。載っていない媒体は本文（188 以降のひな形）が行ごと「—」にする（A-111）。
    hasPrintMedia, hasDigitalMedia,
    // 第４条 電子：電子の条件が全部「入金額」基準なら 乙の受領額 × 料率。混ざれば本文は配信価格の式のまま、備考の行を指す（197 以降のひな形）。
    digitalReceiptBasis: hasDigitalMedia && digitalConds.length > 0 && digitalConds.every((c) => String(c.priceBasis) === "receipts"),
    digitalBasisMixed: digitalConds.some((c) => String(c.priceBasis) === "receipts") && !digitalConds.every((c) => String(c.priceBasis) === "receipts"),
    // 翻訳の立て付け（A-034）。条文と一覧の見出しがこれで入れ替わる。
    translationDerivative,
    translationLabel,
    translationSellOff: pick("翻訳物の在庫販売期間") || "6か月",
    translationShare: translationShare == null ? "" : percentText(translationShare),
    // 支払の表は条件明細の支払条件から写す（読めた語が欄の手入力に勝つ）。読めなければ欄、欄も空なら既定。
    payPrint: payment.payPrint ?? (pick("紙の支払時期") || (hasPrintMedia ? "翌月末日" : "—")),
    // 電子の条件が 1 本も無ければ「—」（配信が無いのに集計期間と支払時期が出ていた。A-107）。欄に書いてあればそれ。
    digitalPeriod: payment.digitalPeriod ?? (pick("電子の集計期間") || (hasDigitalMedia ? "7月1日〜翌年6月30日" : "—")),
    payDigital: payment.payDigital ?? (pick("電子の支払時期") || (hasDigitalMedia ? "10月末日" : "—")),
    payTranslation: payment.payTranslation ?? (pick("翻訳版の支払時期") || (translationShare != null || transTitles.length > 0 ? "翌々月末日" : "—")),
    // 同じ値を欄の名前でも返す。画面の欄が「計算（条件明細から）」になり、手入力で上書きされない。
    ...(payment.payPrint ? { "紙の支払時期": payment.payPrint } : {}),
    ...(payment.digitalPeriod ? { "電子の集計期間": payment.digitalPeriod } : {}),
    ...(payment.payDigital ? { "電子の支払時期": payment.payDigital } : {}),
    ...(payment.payTranslation ? { "翻訳版の支払時期": payment.payTranslation } : {}),
    specialNotes: pick("特記事項"),

    hasBank: Boolean(bank),
    titles,
    /** 一覧に載る作品の点数。第１条の要約と別紙1の見出しに出る（r5）。 */
    titleCount: titles.length,
    hasAnyDigital: titles.some((t) => t.hasDigital),
    /** 作品ごとの許諾期間が一覧に出ているか。第３条がそちらを指す（A-039）。 */
    hasWorkTerms: titles.some((t) => t.hasTerm),
    ...multiPatch(titles, conditions, pick, translationShare)
  };
}

// ---------------------------------------------------------------------------
// 作品ごとに番号を持つ条件書（pub_license_terms_multi）
// ---------------------------------------------------------------------------

/** 既定の文言（DucQrews の条件書 v4 のまま）。文書ごとに画面で直せる。 */
export const MULTI_DEFAULTS = {
  preambleExtra: "著作権者はいずれも許諾者とする。",
  grantPrint: "独占的に許諾する。許諾者は、許諾期間中、本著作物について被許諾者以外の第三者に対し出版を許諾しない。ただし、許諾者自身が本著作物を利用することは妨げられない。この場合において、当該利用が被許諾者による本出版物の販売と競合するときは、許諾者は、利用の時期、数量、販売経路その他の態様につき、被許諾者の販売に不当な影響を及ぼさないよう配慮するものとする。",
  grantDigital: "独占的に許諾する（条件：主要電子書籍ストアにて配信。DRM適用）。許諾者は、許諾期間中、本著作物について被許諾者以外の第三者に対し電子書籍の配信を許諾しない。ただし、許諾者自身が本著作物を利用することは妨げられない。この場合において、当該利用が被許諾者による電子出版物の配信と競合するときは、許諾者は、利用の時期、数量、販売経路その他の態様につき、被許諾者の配信に不当な影響を及ぼさないよう配慮するものとする。",
  grantTranslation: "独占的に許諾する。被許諾者は、本著作物の翻訳（二次的著作物の作成）ならびに翻訳版の出版および配信を、自ら行い、または第三者に再許諾することができる。再許諾の条件は、本条件書に定める許諾地域および許諾期間の範囲内とする。",
  grantPromo: "本出版物の販売促進、広告宣伝、営業資料、プレスリリース、SNS告知その他これらに準ずる目的に必要な範囲で許諾する。",
  grantSecondary: "通常の条件書では対象外（二次的著作物）。本条件書により当然に許諾されるものではなく、当事者間で追加条件書、覚書その他の書面により別途合意した場合に限り許諾される。",
  translationBasis: "算定の基礎は、源泉徴収税額および海外送金手数料を控除した後の被許諾者の実受領額とする。",
  payTiming: "紙書籍：都度払い（刊行日を含む月の翌月末日払い）。電子書籍：年1回・10月末日払い（算定期間：毎年7月1日から翌年6月末日まで、同日締め）。翻訳版：被許諾者が再許諾先から許諾料を受領した日を含む月の翌々月末日払い。報告明細：利用形態別の数量・単価・金額を記載した報告書を提出。",
  coAuthorPay: [
    "基本契約第12条第3項に基づき、被許諾者は、許諾者が書目ごとに定めて被許諾者に通知した対価の配分割合（以下「配分割合」という）に従い、「力造」名義以外の者（以下「共著者」という）に配分されるべき対価（以下「共著者分」という）を、各共著者に直接支払い、その額を許諾者への支払額から控除する。「力造」名義に配分される対価は、許諾者に支払う。これに伴う源泉徴収、支払調書の作成その他の事務は、被許諾者が行う。",
    "前項にかかわらず、被許諾者が許諾者に対し、特定の支払について共著者への分配を書面（電子メールを含む）により委託した場合は、被許諾者は当該支払について共著者分を含む全額を許諾者に支払い、許諾者がこれを各共著者に分配する（源泉徴収、支払調書の作成その他の事務を含む）。この場合、被許諾者は許諾者に対し、分配業務の委託料として、委託1回につき金50,000円（消費税別）を支払う。委託を行うか否かは、被許諾者が決定する。",
    "許諾者は、第1項の直接支払に必要な共著者の情報（氏名、住所、振込先口座、個人番号その他法令上必要なもの）を取りまとめ、被許諾者に提供する。配分割合に変更が生じたときは、許諾者は、変更後の配分割合およびその適用開始時期を遅滞なく被許諾者に通知し、被許諾者は、当該通知の到達後に行う支払から変更後の配分割合を適用する。被許諾者は、当該情報を当該支払および法令上の手続の目的にのみ利用する。許諾者から当該情報の提供がないために被許諾者が直接支払を行えない場合、被許諾者は当該支払について共著者分を含む全額を許諾者に支払うものとし、この場合、前項の委託料は生じない。"
  ].join("\n"),
  thirdPartyIp: "対象著作物ごとに上記一覧の「共同著作・第三者権利」欄および「備考」欄に記載のとおり。",
  copyrightNotice: "対象著作物ごとに上記一覧の「著作権表示」欄記載のとおり。",
  priorAgreements: [
    "本条件書の対象著作物および許諾内容に関し、締結日以前に両当事者間で成立した契約、覚書、条件書、発注書、請求書、電子メール、口頭・黙示の合意、取引慣行その他形式を問わない一切の合意（以下「旧契約等」）は、本条件書および基本契約に統合される。",
    "相互に矛盾・抵触する場合、本条件書、基本契約、旧契約等の順に優先する。",
    "前二項にかかわらず、本条件書に明示されていない商品化、映像化、デジタルゲーム化その他の追加利用は、別途書面または電磁的方法により合意した場合に限り許諾される。"
  ].join("\n"),
  closing: "本個別契約に定めのない事項は基本契約の定めによる。"
} as const;

/** 作品ごとに番号を持つ条件書の項目（一覧形式の項目に足す）。初期値は v4 の文言。 */
export const PUB_TERMS_MULTI_EXTRA_VARIABLES: TemplateVariable[] = [
  { name: "締結日", label: "締結日（空なら「年　月　日」の空欄で出る）", type: "date", group: "I. 基本情報", noGuess: true },
  { name: "副題", label: "副題（タイトルの右。例：1通目／神我狩シリーズ）", group: "I. 基本情報", noGuess: true },
  { name: "前文の追記", label: "前文の追記（点数のあとに続ける文）", type: "textarea", group: "I. 基本情報", noGuess: true,
    default: MULTI_DEFAULTS.preambleExtra },
  { name: "許諾内容_紙", label: "許諾内容：紙媒体出版", type: "textarea", group: "VIII. 条文（作品ごとに番号）", noGuess: true, default: MULTI_DEFAULTS.grantPrint },
  { name: "許諾内容_電子", label: "許諾内容：電子書籍配信", type: "textarea", group: "VIII. 条文（作品ごとに番号）", noGuess: true, default: MULTI_DEFAULTS.grantDigital },
  { name: "許諾内容_翻訳", label: "許諾内容：翻訳版", type: "textarea", group: "VIII. 条文（作品ごとに番号）", noGuess: true, default: MULTI_DEFAULTS.grantTranslation },
  { name: "許諾内容_販促", label: "許諾内容：販促・広告利用", type: "textarea", group: "VIII. 条文（作品ごとに番号）", noGuess: true, default: MULTI_DEFAULTS.grantPromo },
  { name: "許諾内容_二次利用", label: "許諾内容：二次利用", type: "textarea", group: "VIII. 条文（作品ごとに番号）", noGuess: true, default: MULTI_DEFAULTS.grantSecondary },
  { name: "翻訳版の算定の基礎", label: "翻訳版：算定の基礎", type: "textarea", group: "VIII. 条文（作品ごとに番号）", noGuess: true, default: MULTI_DEFAULTS.translationBasis },
  { name: "支払時期・方法", label: "支払時期・方法", type: "textarea", group: "VIII. 条文（作品ごとに番号）", noGuess: true, default: MULTI_DEFAULTS.payTiming },
  { name: "共著者分の支払", label: "共著者分の支払（1 行 1 項。空にすると欄ごと出さない）", type: "textarea", group: "VIII. 条文（作品ごとに番号）",
    noGuess: true, default: MULTI_DEFAULTS.coAuthorPay },
  { name: "旧合意", label: "旧合意・過去利用（1 行 1 項）", type: "textarea", group: "VIII. 条文（作品ごとに番号）", noGuess: true, default: MULTI_DEFAULTS.priorAgreements },
  { name: "特記事項（作品ごと）", label: "特記事項（1 行 1 項。最後に「本個別契約に定めのない事項は基本契約の定めによる。」が付く）",
    type: "textarea", group: "VI. 特記事項", noGuess: true }
];

/** 番号の範囲（ARC-PUBT-2026-0012〜0029）。続いていなければ「・」で並べる。 */
export function termsNoRange(nos: string[]): string {
  const list = [...new Set(nos.map((n) => n.trim()).filter(Boolean))];
  if (!list.length) return "";
  const parsed = list.map((n) => ({ n, m: n.match(/^(.*-)(\d+)$/) }));
  if (parsed.every((p) => p.m) && new Set(parsed.map((p) => p.m![1])).size === 1) {
    const sorted = [...parsed].sort((a, b) => Number(a.m![2]) - Number(b.m![2]));
    const nums = sorted.map((p) => Number(p.m![2]));
    const contiguous = nums.every((v, i) => i === 0 || v === nums[i - 1]! + 1);
    if (sorted.length === 1) return sorted[0]!.n;
    if (contiguous) return `${sorted[0]!.n}〜${sorted[sorted.length - 1]!.m![2]}`;
    return sorted.map((p) => p.n).join("・");
  }
  return list.join("・");
}

const lines = (v: string) => v.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
/** 作品で 1 つにそろっている値（そろっていなければ null）。 */
const uniform = (values: string[]): string | null => {
  const set = [...new Set(values.filter((v) => v && v !== "—"))];
  return set.length === 1 ? set[0]! : null;
};

function multiPatch(titles: Data[], conditions: Data[], pick: (...keys: string[]) => string, translationShare: number | null): Data {
  const own = conditions.filter((c) => !isTranslationCondition(c));
  const prints = own.filter((c) => mediaOfCondition(c) === "print");
  const exemptFirst = uniform(prints.map((c) => text(c.royaltyExemptFirstCopies)));
  const transRates = conditions.filter((c) => isTranslationCondition(c)).map((c) => percentText(c.ratePct));
  const nos = titles.map((t) => text(t.termsNo)).filter(Boolean);
  const special = lines(pick("特記事項（作品ごと）"));
  const coAuthor = lines(pick("共著者分の支払"));
  const prior = lines(pick("旧合意"));
  return {
    termsNoRange: termsNoRange(nos),
    // 締結日は欄に入れたときだけ（Word と同じく、署名の前の紙は「2026年　　月　　日」）。決定日では埋めない。
    multiSignDate: pick("締結日"),
    // 締結日が空のとき（締結の前に出す紙）、ヘッダは「2026年　　月　　日」と年だけ入れる（Word と同じ）。
    signYear: new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric" }).format(new Date()).replace(/[^0-9]/g, ""),
    subtitle: pick("副題"),
    preambleExtra: pick("前文の追記"),
    grantPrint: pick("許諾内容_紙"), grantDigital: pick("許諾内容_電子"), grantTranslation: pick("許諾内容_翻訳"),
    grantPromo: pick("許諾内容_販促"), grantSecondary: pick("許諾内容_二次利用"),
    // 料率は紙 1 枚で 1 つ（作品で違えば「一覧のとおり」にせず警告で分けてもらう）。
    printRateAll: uniform(titles.map((t) => text(t.printRate))) ?? "",
    digitalRateAll: uniform(titles.map((t) => text(t.digitalRate))) ?? "",
    translationRateAll: uniform(transRates) ?? (translationShare != null ? percentText(translationShare) : ""),
    exemptFirstCopies: exemptFirst && Number(exemptFirst) > 0 ? Number(exemptFirst).toLocaleString("ja-JP") : "",
    translationBasis: pick("翻訳版の算定の基礎"),
    payTiming: pick("支払時期・方法"),
    coAuthorPay: coAuthor, hasCoAuthorPay: coAuthor.length > 0,
    priorAgreements: prior, hasPriorAgreements: prior.length > 0,
    thirdPartyIp: MULTI_DEFAULTS.thirdPartyIp,
    copyrightNoticeText: MULTI_DEFAULTS.copyrightNotice,
    multiSpecial: [...special, MULTI_DEFAULTS.closing]
  };
}

/** 作品ごとに番号を持つ条件書だけの警告（料率・期間がそろっているか、番号・按分）。 */
export function pubTermsMultiWarnings(context: Data): Warning[] {
  const out: Warning[] = [];
  const patch = pubTermsPatch(context, {});
  const titles = list(patch.titles);
  const rateSets = (key: string) => [...new Set(titles.map((t) => text(t[key])).filter((v) => v && v !== "—"))];
  for (const [key, label] of [["printRate", "紙"], ["digitalRate", "電子"]] as const) {
    const set = rateSets(key);
    if (set.length > 1) out.push({ kind: "other", message: `${label}の料率が作品で違います（${set.join("・")}）。この条件書は料率を 1 つで書くので、料率ごとに紙を分けてください` });
  }
  const terms = [...new Set(titles.map((t) => text(t.term)).filter(Boolean))];
  if (terms.length > 1) out.push({ kind: "other", message: `許諾期間が作品で違います（${terms.length} 通り）。期間ごとに紙を分けてください` });
  const missing = titles.filter((t) => !text(t.termsNo)).map((t) => text(t.title));
  if (missing.length) out.push({ kind: "other", message: `作品の個別契約がまだ無い作品があります（${missing.slice(0, 5).join("・")}${missing.length > 5 ? ` ほか ${missing.length - 5}` : ""}）。決定のときに作品ごとに個別利用許諾番号を振ります` });
  // 按分（共著の取り分）と著作権表示の食い違い。
  for (const t of titles) {
    const names = text(t.copyright).split(/[／/、,]/).map((x) => x.trim()).filter(Boolean);
    if (names.length > 1 && !t.hasShares) out.push({ kind: "other", message: `${text(t.title)}：著作権表示に ${names.length} 名ありますが、条件明細に共著の取り分がありません（共同著作は「なし」で出ます）` });
    if (names.length <= 1 && t.hasShares) out.push({ kind: "other", message: `${text(t.title)}：条件明細に共著の取り分がありますが、著作権表示が 1 名です` });
  }
  return out;
}
