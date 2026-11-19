import type { TemplateVariable } from "./binding.js";
import type { Warning } from "./preflight.js";
import { contextMasterAgreement } from "./legacy-variables.js";

/**
 * 二次利用追加条件書（secondary_use_terms）。
 *
 * 出版の基本契約は、商品化・映像化・デジタルゲーム化その他の二次利用を「別途合意したときに限り許諾する」と定める
 * （出版等許諾基本契約書 第4条、著作物利用許諾基本契約書V5 第5条と個別条件書の「二次利用」の行）。
 * その別途合意を 1 枚にする紙。利用（商品化・映像化 …）を 1 行ずつ並べ、行ごとに 実施する者（自社／再許諾）・
 * 独占区分・地域と言語・期間・対価 を持つ。
 *
 *   ・基本契約（契約の画面）から作る。条件明細は先に要らない。
 *   ・決定のとき、行から条件明細（取得 IN の利用許諾）を作り、この紙に結び付ける
 *     （secondary-use-conditions.ts）。行に condition_id を書き戻すので、訂正版で二重には作らない。
 *   ・当事者の呼び方（甲乙／許諾者・被許諾者）と参照する条は、基本契約が V5 かどうかで出し分ける。
 *
 * 本文は infra/v3/templates/secondary_use_terms.html（登録は infra/v3/219）。項目はコードが持つ。
 */
export const SECONDARY_USE_KEY = "secondary_use_terms";
export const isSecondaryUseTemplate = (templateKey: string): boolean => templateKey === SECONDARY_USE_KEY;
/** 利用の表（明細）。1 行が 1 つの利用。 */
export const SUT_USES_FIELD = "sut_uses";

type Data = Record<string, any>;
type Row = Record<string, unknown>;

/** 行の作品を台帳から引いたもの（secondary-use-conditions.ts の withSecondaryUseWorks が文脈に足す）。 */
export interface SecondaryWork {
  id: number; title: string; kind: string;
  /** 原作名（計算書の件名）。二次利用の作品では「シノビガミシリーズ」のような総称。 */
  sourceTitle: string | null;
  copyright: string | null;
  /** この相手先との出版の個別条件書（個別契約）の番号。 */
  termsNo: string | null;
  /** 原作（系譜の親）。二次利用の作品なら配下の書籍。 */
  sources: Array<{ id: number; title: string; copyright: string | null; termsNo: string | null }>;
}

/** 利用区分。基本契約（旧）第4条第1項の並びに合わせる。 */
export const SUT_CATEGORIES = ["商品化", "映像化", "デジタルゲーム化", "翻訳・翻案", "その他"] as const;
/** 実施する者。own＝当社が自ら行う／sublicense＝第三者に再許諾して行わせる。 */
export const SUT_ACTORS = [
  { value: "own", label: "自社" },
  { value: "sublicense", label: "再許諾" }
] as const;
/** 対価の決め方。rate＝料率／flat＝定額（一括）。 */
export const SUT_FEE_TYPES = [
  { value: "rate", label: "料率" },
  { value: "flat", label: "定額（一括）" }
] as const;

export const SUT_DEFAULTS = {
  approvalTargets: "商品化：デザイン案および量産前のサンプル。映像化：企画書、シリーズ構成・脚本、キャラクター設定、本編の完成前映像および主要な宣伝素材。",
  approvalDays: "10",
  approvalMode: "承認とみなす",
  approvalDeemedDays: "5",
  payOwn: "製造数量が確定した日を含む月の翌月末日",
  paySub: "翌々月末日",
  payFlat: "本書の締結日を含む月の翌月末日",
  /** 終了後に製造済みの商品を売れる期間。基本契約V5 第24条第1項第1号と同じ 12 か月。 */
  sellOffMonths: "12",
  /** 自社で製造する商品の算定の基礎。 */
  ownBase: "商品の税抜希望小売価格 × 製造数量"
} as const;

export const SECONDARY_USE_VARIABLES: TemplateVariable[] = [
  { name: "書類番号", label: "書類番号", group: "I. 基本情報", dbField: "auto.docNumber", noGuess: true },
  { name: "締結日", label: "締結日", type: "date", group: "I. 基本情報", dbField: "auto.today", noGuess: true },
  { name: "基本契約の版", label: "基本契約の版", type: "select", options: ["自動", "旧（出版等許諾基本契約書）", "V5（著作物利用許諾基本契約書V5）"],
    group: "I. 基本情報", noGuess: true, default: "自動",
    helpText: "当事者の呼び方（甲乙／許諾者・被許諾者）と参照する条が変わります。自動＝基本契約の文書が V5 なら V5、そうでなければ旧" },
  { name: "基本契約名", label: "基本契約名（前文）", group: "I. 基本情報", noGuess: true,
    helpText: "空なら、選んだ基本契約の「◯年◯月◯日付 ◯◯契約書」" },

  { name: "許諾者名称", label: "許諾者 名称", group: "II. 許諾者", required: true, from: "condition.counterparty.name" },
  { name: "許諾者住所", label: "許諾者 住所", type: "textarea", group: "II. 許諾者", from: "condition.counterparty.address" },
  { name: "許諾者代表者名", label: "許諾者 代表者名", group: "II. 許諾者", dbField: "vendor.vendor_rep_line", noGuess: true,
    helpText: "法人の代表者の肩書と氏名。個人は空のまま" },
  { name: "許諾者登録番号", label: "許諾者 登録番号（T番号）", group: "II. 許諾者", from: "condition.counterparty.invoiceNo" },
  { name: "許諾者連絡先", label: "許諾者 通知先", type: "contact", group: "II. 許諾者", dbField: "vendor.contact_line", noGuess: true },

  { name: "被許諾者名称", label: "被許諾者 名称", group: "III. 被許諾者", required: true, from: "company.name" },
  { name: "被許諾者住所", label: "被許諾者 住所", type: "textarea", group: "III. 被許諾者", from: "company.address" },
  { name: "被許諾者代表者名", label: "被許諾者 代表者名", group: "III. 被許諾者", from: "company.rep" },
  { name: "被許諾者登録番号", label: "被許諾者 登録番号（T番号）", group: "III. 被許諾者", from: "company.invoiceNo" },
  { name: "被許諾者連絡先", label: "被許諾者 通知先", type: "contact", group: "III. 被許諾者", dbField: "staff.contact_line", noGuess: true },

  { name: SUT_USES_FIELD, label: "許諾する二次利用", type: "array", group: "IV. 許諾する二次利用" },

  { name: "再許諾先", label: "再許諾先（03）", type: "textarea", group: "V. 再許諾", noGuess: true,
    helpText: "空なら、利用の表の「再許諾先」を並べます（B：◯◯社 ／ C：◯◯製作委員会）" },
  { name: "主要条件", label: "主要条件（03）", type: "textarea", group: "V. 再許諾", noGuess: true,
    helpText: "制作会社、配信先、対象プラットフォーム、制作スケジュール、主要な収益条件の概要。映像化・ゲーム化の再許諾は、ここに書いた内容で承諾を得る。空なら行を出さない" },

  { name: "前払金", label: "前払金（04）", type: "textarea", group: "VI. 対価・支払", noGuess: true,
    helpText: "空なら「なし。」。例：金 500,000円（税別）を本書締結の翌月末日までに支払い、以後の対価に充当する。返還しない。" },
  { name: "自社の支払時期", label: "自社の支払時期（05）", group: "VI. 対価・支払", noGuess: true, default: SUT_DEFAULTS.payOwn,
    helpText: "「製造のつど、◯◯までに支払う。」の◯◯" },
  { name: "再許諾の支払時期", label: "再許諾の支払時期（05）", group: "VI. 対価・支払", noGuess: true, default: SUT_DEFAULTS.paySub,
    helpText: "「再許諾先から対価を受領した日を含む月の◯◯までに支払う。」の◯◯" },
  { name: "定額の支払時期", label: "定額の支払時期（05）", group: "VI. 対価・支払", noGuess: true, default: SUT_DEFAULTS.payFlat,
    helpText: "定額（一括）の利用があるときだけ出る。「◯◯までに支払う。」の◯◯" },

  { name: "監修の対象", label: "監修の対象（06）", type: "textarea", group: "VII. 監修・権利・終了", noGuess: true,
    default: SUT_DEFAULTS.approvalTargets },
  { name: "回答の期限", label: "回答の期限（営業日）", group: "VII. 監修・権利・終了", noGuess: true, default: SUT_DEFAULTS.approvalDays },
  { name: "回答がないとき", label: "回答がないとき", type: "select", options: ["承認とみなす", "協議する"],
    group: "VII. 監修・権利・終了", noGuess: true, default: SUT_DEFAULTS.approvalMode,
    helpText: "承認とみなす＝催告から下の営業日以内に回答がなければ承認とみなす。協議する＝みなし承認を置かず、速やかに協議する" },
  { name: "みなし承認までの日数", label: "催告からみなし承認まで（営業日）", group: "VII. 監修・権利・終了", noGuess: true,
    default: SUT_DEFAULTS.approvalDeemedDays, helpText: "「回答がないとき」が「承認とみなす」のときだけ使う" },
  { name: "原作表示", label: "原作表示（07）", group: "VII. 監修・権利・終了", noGuess: true,
    helpText: "例：原作：星降る夜のはなし（見本 太郎）。空なら著作権表示だけ" },
  { name: "在庫の販売期間", label: "終了後の在庫の販売期間（か月）", group: "VII. 監修・権利・終了", noGuess: true,
    default: SUT_DEFAULTS.sellOffMonths, helpText: "基本契約V5 第24条と同じ 12 か月が既定" },
  { name: "特約事項", label: "特約事項（09）", type: "textarea", group: "VIII. 特約事項", noGuess: true,
    helpText: "許諾者に留保する利用、優先交渉、従前の合意の扱いなど。空なら「なし」" },
  { name: "署名欄", label: "署名欄", type: "select", options: ["表示する", "表示しない"], group: "VIII. 特約事項", noGuess: true, default: "表示する" }
];

const text = (v: unknown): string => (v == null ? "" : String(v).trim());
const rowsOf = (v: unknown): Row[] =>
  Array.isArray(v) ? v.filter((x): x is Row => Boolean(x) && typeof x === "object") : [];
const joinContact = (parts: unknown[]) => parts.map((v) => text(v)).filter(Boolean).join(" ／ ");
const numberOf = (v: unknown): number | null => {
  const s = text(v).replace(/[,，%％円\s]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const dotDate = (v: unknown): string => {
  const m = text(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}.${Number(m[2])}.${Number(m[3])}` : text(v);
};
/** 行の符号。A, B, … Z, AA, AB …。 */
export const useCode = (index: number): string => {
  let n = index; let out = "";
  do { out = String.fromCharCode(65 + (n % 26)) + out; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return out;
};

/** 画面の行を、紙と条件明細の両方が読む形に寄せる。中身の無い行は落とす。 */
export interface SecondaryUse {
  index: number; code: string;
  category: string;
  content: string;
  actor: "own" | "sublicense";
  sublicensee: string;
  workId: number | null; workTitle: string;
  exclusivity: "exclusive" | "non_exclusive" | null;
  regions: string; languages: string;
  termStart: string; termEnd: string;
  feeType: "rate" | "flat";
  ratePct: number | null; flatAmount: number | null;
  /** 自社の算定の基礎（税抜希望小売価格 × 製造数量 など）。 */
  base: string;
  /** 対価の行に続ける文（非加算の定めなど）。 */
  feeNote: string;
  conditionId: number | null;
  row: Row;
}

export function secondaryUses(manual: Data): SecondaryUse[] {
  const rows = rowsOf(manual[SUT_USES_FIELD]);
  const out: SecondaryUse[] = [];
  for (const row of rows) {
    const category = text(row.category);
    const content = text(row.content);
    if (!category && !content && numberOf(row.rate) == null && numberOf(row.flat_amount) == null && !Number(row.work_id)) continue;
    const index = out.length;
    out.push({
      index, code: useCode(index),
      category: category || "その他",
      content,
      actor: text(row.actor) === "sublicense" ? "sublicense" : "own",
      sublicensee: text(row.sublicensee),
      workId: Number(row.work_id) > 0 ? Number(row.work_id) : null,
      workTitle: text(row.work_title),
      exclusivity: text(row.exclusivity) === "exclusive" ? "exclusive" : text(row.exclusivity) === "non_exclusive" ? "non_exclusive" : null,
      regions: text(row.regions), languages: text(row.languages),
      termStart: text(row.term_start), termEnd: text(row.term_end),
      feeType: text(row.fee_type) === "flat" ? "flat" : "rate",
      ratePct: numberOf(row.rate), flatAmount: numberOf(row.flat_amount),
      base: text(row.base) || SUT_DEFAULTS.ownBase,
      feeNote: text(row.fee_note),
      conditionId: Number(row.condition_id) > 0 ? Number(row.condition_id) : null,
      row
    });
  }
  return out;
}

const pctText = (n: number | null): string => (n == null ? "" : `${Number.isInteger(n) ? n : Number(n.toFixed(4))}%`);
const yenText = (n: number | null): string => (n == null ? "" : `金 ${Math.round(n).toLocaleString("ja-JP")}円（税別）`);

/** 対価の 1 文。料率・金額が空の行は空（決定の前の注意に出す）。 */
export function useFeeText(use: SecondaryUse, partyB: string): string {
  const tail = use.feeNote ? `${use.feeNote.replace(/。$/, "")}。` : "";
  if (use.feeType === "flat") return use.flatAmount == null ? "" : `${yenText(use.flatAmount)}（一括）。${tail}`;
  if (use.ratePct == null) return "";
  return use.actor === "sublicense"
    ? `${partyB}が再許諾先から現実に受領した金額 × ${pctText(use.ratePct)}。${tail}`
    : `${use.base} × ${pctText(use.ratePct)}。${tail}`;
}

/** 基本契約が V5 か。欄で選んでいればそれ、「自動」なら基本契約の文書から。 */
export function isV5Paper(context: Data, manual: Data): boolean {
  const picked = text(manual["基本契約の版"] ?? context["基本契約の版"]);
  if (picked.startsWith("V5")) return true;
  if (picked.startsWith("旧")) return false;
  return (contextMasterAgreement(context) as Data | null)?.isV5Master === true;
}

/** 本文に渡す値。項目（bound）→ 手入力（manual）→ 文脈 の順（pubTermsPatch と同じ規則）。 */
export function secondaryUsePatch(context: Data, manual: Data = {}): Data {
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const value = manual[key] ?? context[key];
      if (value != null && String(value).trim() !== "") return String(value).trim();
    }
    return "";
  };
  const counterparty = context.condition?.counterparty ?? {};
  const isCorp = text(counterparty.kind) !== "individual";
  const contacts = Array.isArray(context.contacts) ? context.contacts : [];
  const primary = contacts.find((c: Data) => c?.role === "primary") ?? {};
  const company = context.company ?? {};
  const owner = context.owner ?? {};
  const representative = [text(counterparty.representativeTitle), text(counterparty.representativeName)].filter(Boolean).join(" ");
  const master = contextMasterAgreement(context) as Data | null;
  const isV5 = isV5Paper(context, manual);
  const partyA = isV5 ? "甲" : "許諾者";
  const partyB = isV5 ? "乙" : "被許諾者";

  const uses = secondaryUses(manual);
  const ledger = (context.secondaryWorks ?? {}) as Record<number, SecondaryWork>;
  // 01 対象著作物：行に出てくる作品を、出てきた順に 1 回ずつ。二次利用の作品（原作を持つ作品）は、作品そのもの
  // ではなく配下の原作を並べる（グッズの作品ではなく、シノビガミの各書籍が許諾の対象）。
  const works: Array<{ no: number; id: number | null; title: string; copyright: string; termsNo: string }> = [];
  const pushWork = (id: number | null, title: string, copyright: string, termsNo: string) => {
    if (works.some((w) => (id != null ? w.id === id : w.title === title))) return;
    works.push({ no: works.length + 1, id, title, copyright, termsNo });
  };
  /** 行が二次利用の作品を指していれば、その作品（原作つき）。 */
  const derived = (u: SecondaryUse): SecondaryWork | null => {
    const w = u.workId != null ? ledger[u.workId] : undefined;
    return w && w.sources.length ? w : null;
  };
  for (const u of uses) {
    if (!u.workTitle && !u.workId) continue;
    const d = derived(u);
    if (d) {
      // 行の著作権表示は、原作に表示が無いときの代わり。
      for (const s of d.sources) pushWork(s.id, s.title, s.copyright ?? text(u.row.copyright), s.termsNo ?? "");
      continue;
    }
    const w = u.workId != null ? ledger[u.workId] : undefined;
    pushWork(u.workId, u.workTitle || w?.title || "", text(u.row.copyright) || (w?.copyright ?? ""), text(u.row.terms_no) || (w?.termsNo ?? ""));
  }
  const multiWorks = works.length > 1;
  /** 02 の行に添える対象。二次利用の作品は「シノビガミ グッズ（原作 17 点。01 のとおり）」。 */
  const workRefOf = (u: SecondaryUse): string => {
    const d = derived(u);
    if (d) return `${d.title}（${d.sourceTitle ? `${d.sourceTitle}・` : ""}原作 ${d.sources.length} 点。01 のとおり）`;
    return multiWorks ? u.workTitle : "";
  };
  const codesOf = (list: SecondaryUse[]) => list.map((u) => u.code).join("・");
  const subs = uses.filter((u) => u.actor === "sublicense");
  const owns = uses.filter((u) => u.actor === "own" && u.feeType !== "flat");
  const flats = uses.filter((u) => u.feeType === "flat");
  // 再許諾先：欄に書いてあればそのまま。空なら行の再許諾先を符号つきで並べる。
  const sublicensees = pick("再許諾先")
    || subs.filter((u) => u.sublicensee).map((u) => `${u.code}：${u.sublicensee}`).join("　／　")
    || "未定（決まりしだい、被許諾側から書面で通知し、承諾を得る）";
  const approvalDeemed = pick("回答がないとき") !== "協議する";

  return {
    docNo: pick("書類番号") || text(context.document?.number),
    signDate: pick("締結日") || text(context.document?.issuedOn),
    isV5, partyA, partyB,
    agreementNo: text(master?.no),
    agreementTitle: pick("基本契約名") || text(master?.datedTitle ?? master?.title) || (isV5 ? "著作物利用許諾基本契約書" : "出版等許諾基本契約書"),

    licensorName: pick("許諾者名称") || text(counterparty.name),
    licensorAddress: pick("許諾者住所") || text(counterparty.address),
    licensorRep: isCorp ? (pick("許諾者代表者名") || representative) : "",
    licensorInvoiceNo: pick("許諾者登録番号") || text(counterparty.invoiceNo),
    licensorContact: pick("許諾者連絡先")
      || joinContact([primary.department, primary.name, primary.email, primary.phone])
      || (isCorp ? "" : joinContact([counterparty.name, counterparty.email, counterparty.phone])),
    licenseeName: pick("被許諾者名称") || text(company.name),
    licenseeAddress: pick("被許諾者住所") || text(company.address),
    licenseeRep: pick("被許諾者代表者名") || text(company.rep ?? company.representative),
    licenseeInvoiceNo: pick("被許諾者登録番号") || text(company.invoiceNo),
    licenseeContact: pick("被許諾者連絡先")
      || joinContact([owner.department, owner.name, owner.email, owner.phone])
      || joinContact([company.department ?? company.contactDepartment, company.contactName ?? company.contact,
                      company.email ?? company.contactEmail, company.tel ?? company.phone]),

    works, multiWorks,
    uses: uses.map((u) => ({
      code: u.code,
      category: u.category,
      sublicensed: u.actor === "sublicense",
      content: u.content,
      // 作品が 2 点以上あるとき、または二次利用の作品（原作つき）のとき、どの作品の利用かを行に書く。
      workRef: workRefOf(u),
      actor: u.actor === "sublicense" ? "再許諾先（03）" : `${partyB}（自社）`,
      exclusivity: u.exclusivity === "exclusive" ? "独占" : u.exclusivity === "non_exclusive" ? "非独占" : "—",
      scope: `${u.regions || "全世界"}／${u.languages || "全言語"}`,
      term: u.termStart || u.termEnd ? `${dotDate(u.termStart) || "—"}〜${dotDate(u.termEnd) || "定めなし"}` : "基本契約の有効期間中",
      feeLabel: `${u.category}（${u.feeType === "flat" ? "定額" : u.actor === "sublicense" ? "再許諾" : "自社"}）`,
      feeText: useFeeText(u, partyB) || "（未入力）"
    })),
    hasSublicense: subs.length > 0,
    hasOwn: owns.length > 0,
    hasFlat: flats.length > 0,
    subCodes: codesOf(subs.filter((u) => u.feeType !== "flat")) || codesOf(subs),
    ownCodes: codesOf(owns),
    /** 自社で行う利用の全部（定額を含む）。03 の「再許諾しない」の対象。 */
    ownAllCodes: codesOf(uses.filter((u) => u.actor === "own")),
    flatCodes: codesOf(flats),
    sublicensees,
    mainTerms: pick("主要条件"),
    advanceText: pick("前払金"),
    payOwn: pick("自社の支払時期") || SUT_DEFAULTS.payOwn,
    paySub: pick("再許諾の支払時期") || SUT_DEFAULTS.paySub,
    payFlat: pick("定額の支払時期") || SUT_DEFAULTS.payFlat,
    approvalTargets: pick("監修の対象") || SUT_DEFAULTS.approvalTargets,
    approvalDays: pick("回答の期限") || SUT_DEFAULTS.approvalDays,
    approvalDeemed,
    approvalDeemedDays: pick("みなし承認までの日数") || SUT_DEFAULTS.approvalDeemedDays,
    creditText: pick("原作表示"),
    sellOffMonths: pick("在庫の販売期間") || SUT_DEFAULTS.sellOffMonths,
    specialNotes: pick("特約事項"),
    showSignature: pick("署名欄") !== "表示しない",
    hasBank: Boolean(context.bank)
  };
}

/** 決定する前に見せる注意。条件明細にできない行（作品・料率が無い）は名指しする。 */
export function secondaryUseWarnings(context: Data, manual: Data = {}): Warning[] {
  const out: Warning[] = [];
  const uses = secondaryUses(manual);
  if (!uses.length) {
    out.push({ kind: "other", message: "「許諾する二次利用」に行がありません。「行を足す」で、利用（商品化・映像化など）を 1 行ずつ入れてください" });
    return out;
  }
  if (!contextMasterAgreement(context)) {
    out.push({ kind: "other", message: "基本契約が選ばれていません。この紙は基本契約に基づく追加条件書なので、契約の画面で基本契約を開いて「二次利用追加条件書を作る」から作ってください" });
  }
  for (const u of uses) {
    const lacks: string[] = [];
    if (!u.workId) lacks.push("対象著作物");
    if (!u.content) lacks.push("利用の内容");
    if (u.feeType === "flat" ? u.flatAmount == null : u.ratePct == null) lacks.push(u.feeType === "flat" ? "金額" : "料率");
    if (u.actor === "sublicense" && u.feeType === "rate" && u.ratePct != null && (u.ratePct <= 0 || u.ratePct > 100)) lacks.push("料率（0〜100%）");
    if (lacks.length) out.push({ kind: "other", message: `${u.code}（${u.category}）：${lacks.join("・")}が入っていません。決定のときに条件明細を作れません` });
  }
  // 二次利用の作品（原作つき）で、計算書の件名（原作名）が空のもの。空だと計算書の件名に原作の題名が全部並ぶ。
  const ledger = (context.secondaryWorks ?? {}) as Record<number, SecondaryWork>;
  for (const u of uses) {
    const w = u.workId != null ? ledger[u.workId] : undefined;
    if (w && w.sources.length && !w.sourceTitle) {
      out.push({ kind: "other", message: `${u.code}（${u.category}）：作品「${w.title}」に原作名（計算書の件名）がありません。`
        + `利用許諾料計算書の件名に原作 ${w.sources.length} 点の題名が並ぶので、作品の画面で原作名（例：シリーズ名）を入れてください` });
    }
  }
  const pending = uses.filter((u) => !u.conditionId).length;
  if (pending) {
    out.push({ kind: "other", message: `決定すると、利用の行から条件明細を ${pending} 本作り、この紙に結び付けます（自社＝自社製造・自社販売、再許諾＝再許諾の条件）` });
  }
  return out;
}
