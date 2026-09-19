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

import type { TemplateVariable } from "./binding.js";
import type { Warning } from "./preflight.js";
import { type PubMedia, pubMediaOfScopes } from "../core/pub-media.js";
import { isSublicensingUsage, pubMediaOfUsage } from "../core/condition-usage.js";

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
export const PUB_TERMS_KEYS: readonly string[] = [PUB_TERMS_KEY, PUB_TERMS_ANNEX_KEY];
export const isPubTermsTemplate = (templateKey: string): boolean => PUB_TERMS_KEYS.includes(templateKey);
/** 別紙形式か（本文の組み方の違い。警告の出し分けに使う）。 */
export const isPubTermsAnnex = (templateKey: string): boolean => templateKey === PUB_TERMS_ANNEX_KEY;

/** これを超えたら別紙形式を勧める作品数。A4 縦で本文の前に表が1ページ以上続く目安。 */
export const PUB_TITLES_ANNEX_HINT = 12;

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
  { name: "基本契約番号", label: "基本契約番号", group: "I. 基本情報", from: "agreement.no" },
  { name: "基本契約名", label: "基本契約名", group: "I. 基本情報", from: "agreement.title" },
  { name: "署名欄", label: "署名欄（末尾の記名押印欄）", type: "select", options: ["表示する", "表示しない"],
    group: "I. 基本情報", noGuess: true, default: "表示する",
    helpText: "基本契約と一括で電子署名する場合は「表示しない」にすると、基本契約側の署名欄だけになります。" },

  { name: "許諾者名称", label: "許諾者（甲）名称", group: "II. 許諾者（甲）", required: true,
    from: "condition.counterparty.name" },
  { name: "許諾者住所", label: "許諾者（甲）住所", type: "textarea", group: "II. 許諾者（甲）",
    from: "condition.counterparty.address" },
  { name: "許諾者代表者名", label: "許諾者（甲）代表者名", group: "II. 許諾者（甲）",
    dbField: "vendor.vendor_rep", noGuess: true,
    helpText: "個人の許諾者なら空のままでよい" },
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
  { name: "更新期間", label: "更新の単位", group: "IV. 許諾期間・地域・言語", noGuess: true, default: "1年" },
  { name: "終了通知期限", label: "終了の通知期限（満了の何か月前）", group: "IV. 許諾期間・地域・言語",
    noGuess: true, default: "1か月", helpText: "契約（合意）に更新通知の月数があればそれが入ります" },
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
    default: "翌月末日", helpText: "「刷部数確定の都度、◯◯までに支払う」の◯◯" },
  { name: "電子の集計期間", label: "電子書籍の集計期間", group: "V. 許諾料・支払", noGuess: true,
    default: "7月1日〜翌年6月30日" },
  { name: "電子の支払時期", label: "電子書籍の支払時期", group: "V. 許諾料・支払", noGuess: true,
    default: "10月末日" },
  { name: "翻訳版の支払時期", label: "翻訳版の支払時期", group: "V. 許諾料・支払", noGuess: true,
    default: "翌々月末日", helpText: "「乙が再許諾先から対価を受領した日の◯◯までに」の◯◯" },

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
    const notes = [...new Set(group.map((c) => text(c.notes)).filter(Boolean))].join("／");
    return {
      item_name: title,
      title,
      edition,
      // 作品に持たせた著作権表示・第三者権利（A-027）。無ければ行で人が入れる。
      copyright: text(head.work?.copyrightNotice),
      third_party: text(head.work?.thirdPartyRights),
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
  const end = maxDate(conditions.map((c) => text(c.termEnd)));
  if (start) out["許諾開始日"] = start;
  if (end) out["許諾終了日"] = end;
  const region = scopeLabels(context, "region");
  const language = scopeLabels(context, "language");
  if (region) out["許諾地域"] = region;
  if (language) out["許諾言語"] = language;
  if (context.agreement && typeof context.agreement.autoRenewal === "boolean") {
    out["自動更新"] = context.agreement.autoRenewal ? "する" : "しない";
  }
  const months = number(context.agreement?.renewalNoticeMonths);
  if (months) out["終了通知期限"] = `${months}か月`;
  return out;
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
  const byId = new Map(conditions.map((c) => [Number(c.id), c]));
  const seeds = pubTitleSeeds(context);
  const rows = list(manual[PUB_TITLES_FIELD]).length ? list(manual[PUB_TITLES_FIELD]) : seeds;

  // 翻訳の立て付け（A-034）。一覧の行の見出しにも条文にも同じ語を使うので、
  // 行を組む前に決めておく（each の中からは外側の値が見えない）。
  const translationDerivative = pick("翻訳の扱い") === "二次的著作物";
  const translationLabel = translationDerivative ? "翻訳版" : "翻訳版再許諾";

  const titles = rows.map((row, index) => {
    const print = row.print_condition_id != null ? byId.get(Number(row.print_condition_id)) : undefined;
    const digital = row.digital_condition_id != null ? byId.get(Number(row.digital_condition_id)) : undefined;
    const transPrint = row.trans_print_condition_id != null ? byId.get(Number(row.trans_print_condition_id)) : undefined;
    const transDigital = row.trans_digital_condition_id != null ? byId.get(Number(row.trans_digital_condition_id)) : undefined;
    const fromLedger = Boolean(print || digital || transPrint || transDigital);
    // 翻訳版は「紙 50%／電子 40%」のように1つの欄にまとめる。列を2つ足すと
    // A4 縦に収まらない。片方だけの作品はその媒体だけ出す。
    const transPrintRate = transPrint ? percentText(transPrint.ratePct) : text(row.trans_print_rate);
    const transDigitalRate = transDigital ? percentText(transDigital.ratePct) : text(row.trans_digital_rate);
    const transText = [transPrintRate ? `紙 ${transPrintRate}` : "",
                       transDigitalRate ? `電子 ${transDigitalRate}` : ""].filter(Boolean).join("／");
    const transConsent = (transPrint || transDigital)
      ? ([transPrint, transDigital].filter(Boolean).some((c) => consentLabel(c!.sublicenseConsent) === "要") ? "要" : "不要")
      : text(row.trans_consent);
    return {
      no: index + 1,
      title: text(row.title) || text(row.item_name),
      edition: text(row.edition),
      copyright: text(row.copyright),
      thirdParty: text(row.third_party) || "なし",
      note: text(row.note),
      printRate: fromLedger ? (print ? percentText(print.ratePct) : "—") : (text(row.print_rate) || "—"),
      printExclusivity: fromLedger ? (print ? exclusivityText(print) || "—" : "—")
        : (text(row.print_exclusivity) || "—"),
      digitalRate: fromLedger ? (digital ? percentText(digital.ratePct) : "—") : (text(row.digital_rate) || "—"),
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
      // 作品の下に続ける行（翻訳版・備考）を出すか。どちらも無ければ行を作らない。
      hasNoteRow: Boolean(transText) || text(row.note) !== "",
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
    agreementNo: pick("基本契約番号") || text(context.agreement?.no),
    agreementTitle: pick("基本契約名") || text(context.agreement?.title) || "出版等利用許諾基本契約書",
    showSignature: pick("署名欄") !== "表示しない",

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
    licenseeContact: pick("被許諾者連絡先")
      || joinContact([context.owner?.department, context.owner?.name, context.owner?.email, context.owner?.phone]),

    // 欄が空なら条件明細の期間の外包み（文案と同じ規則）。空の期間を紙に出さない。
    termStart: pick("許諾開始日") || minDate(conditions.map((c) => text(c.termStart))),
    termEnd: pick("許諾終了日") || maxDate(conditions.map((c) => text(c.termEnd))),
    autoRenew,
    renewPeriod: pick("更新期間") || "1年",
    noticeBefore: pick("終了通知期限") || "1か月",
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
    // 翻訳の立て付け（A-034）。条文と一覧の見出しがこれで入れ替わる。
    translationDerivative,
    translationLabel,
    translationSellOff: pick("翻訳物の在庫販売期間") || "6か月",
    translationShare: translationShare == null ? "" : percentText(translationShare),
    payPrint: pick("紙の支払時期") || "翌月末日",
    digitalPeriod: pick("電子の集計期間") || "7月1日〜翌年6月30日",
    payDigital: pick("電子の支払時期") || "10月末日",
    payTranslation: pick("翻訳版の支払時期") || "翌々月末日",
    specialNotes: pick("特記事項"),

    hasBank: Boolean(bank),
    titles,
    /** 一覧に載る作品の点数。第１条の要約と別紙1の見出しに出る（r5）。 */
    titleCount: titles.length,
    hasAnyDigital: titles.some((t) => t.hasDigital)
  };
}
