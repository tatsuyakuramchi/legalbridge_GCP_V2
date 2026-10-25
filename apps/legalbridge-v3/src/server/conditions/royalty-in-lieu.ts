import { conditionUsageLabel } from "../core/condition-usage.js";

/**
 * 初版の利用許諾料を委託報酬として払う発注（A-077。T17）。
 *
 * 原稿・イラストなど受注者帰属の成果物の制作対価を、別途の制作報酬ではなく「初版の出版に
 * 係る利用許諾料」とする。発注時点では本体価格・初版部数が決まっていないので、見込みで
 * 仮計算した額を委託料の行の確定額にし、納品後 60 日以内に本体価格・部数を確定して検収書で
 * 払う（確定額が仮計算額を下回れば仮計算額＝減額にしない）。これが取適法・フリーランス法の
 * 「算定方法の明示」「受領後 60 日以内の支払」の受け皿になる。
 *
 * 2 版目以降・電子は出版基本契約の個別契約（個別出版条件書）による印税で、初版は計算書の対象外。
 *
 * 非加算部数（献本・見本等）は、初版については算定方法に明記したときだけ引く（既定 0＝全部数）。
 * 2 版目以降は発行部数の % で持つ。
 *
 * ここは純関数（DB 非依存）。画面の下書きとサーバの登録・発注書の特約が同じ文・同じ計算を使う。
 */

/** 委託料の行の報酬名。発注書は「初版利用許諾料（仮計算。確定は特約第3項）」、検収書は確定額として出る。 */
export const IN_LIEU_REWARD_LABEL = "初版利用許諾料";

/** 初版の算定の基礎。発注時は見込み、確定後は確定値。 */
export interface FirstEditionBasis {
  /** 本体価格（税抜・円）。 */
  price: number;
  /** 初版発行部数。 */
  copies: number;
  /** 料率（%）。 */
  ratePct: number;
  /** 非加算部数（献本・見本等）。0／空なら全部数。 */
  exemptCopies?: number | null;
}

/** 初版利用許諾料の計算：本体価格 × （部数 − 非加算）× 率。四捨五入。部数が非加算以下なら 0。 */
export function firstEditionFee(basis: FirstEditionBasis): number {
  const copies = Math.max(0, Math.floor(basis.copies) - Math.floor(basis.exemptCopies ?? 0));
  const raw = basis.price * copies * basis.ratePct / 100;
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 0;
}

/** 算定方法の文（「本体価格（税抜）×（初版発行部数 − 献本・見本等の非加算部数100部）× 10％」）。 */
export function firstEditionFormulaText(basis: Pick<FirstEditionBasis, "ratePct" | "exemptCopies">): string {
  const exempt = Math.floor(basis.exemptCopies ?? 0);
  return exempt > 0
    ? `本体価格（税抜）×（初版発行部数 − 献本・見本等の非加算部数${exempt.toLocaleString("ja-JP")}部）× ${pct(basis.ratePct)}％`
    : `本体価格（税抜）× 初版発行部数 × ${pct(basis.ratePct)}％`;
}

/** 算定の基礎の短い言い方（明細の仕様・検収の内訳に出す）。「本体価格 1,000円 ×（初版 3,000部 − 献本等 100部）× 10%」 */
export function firstEditionBasisText(basis: FirstEditionBasis, label: "見込み" | "確定" = "見込み"): string {
  const exempt = Math.floor(basis.exemptCopies ?? 0);
  const copies = exempt > 0
    ? `（初版 ${basis.copies.toLocaleString("ja-JP")}部 − 献本等 ${exempt.toLocaleString("ja-JP")}部）`
    : `初版 ${basis.copies.toLocaleString("ja-JP")}部`;
  return `算定の基礎（${label}）：本体価格 ${basis.price.toLocaleString("ja-JP")}円（税抜）× ${copies} × ${pct(basis.ratePct)}%`;
}

/** 2 版目以降の非加算（発行部数の %）の文。空か 0 なら空文字。 */
export function laterExemptText(pctValue: number | null | undefined): string {
  return pctValue ? `発行部数の${pct(pctValue)}％にあたる献本等の非加算部数` : "";
}

/** 発注書の利用許諾条件の表に出す短い注記。「初版は明細の初版利用許諾料で支払済み（非加算 100部）／2版以降は発行部数の1%を非加算」 */
export function inLieuShortNote(firstExempt: number | null | undefined, laterPct: number | null | undefined): string {
  const first = `初版は明細の初版利用許諾料で支払済み${firstExempt ? `（非加算 ${Math.floor(firstExempt).toLocaleString("ja-JP")}部）` : ""}`;
  const later = laterPct ? `2版以降は発行部数の${pct(laterPct)}%を非加算` : "";
  return [first, later].filter(Boolean).join("／");
}

const pct = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2))));
const yen = (n: number) => Math.round(n).toLocaleString("ja-JP");

/** 2 版目以降・電子の算定式。 */
export function royaltyFormulaText(usageType: unknown, ratePct: number, laterExemptPct?: number | null): string {
  const rate = `${pct(ratePct)}％`;
  const exempt = laterExemptText(laterExemptPct);
  switch (String(usageType ?? "")) {
    case "pub_print":   return exempt ? `紙版：本体価格 ×（発行部数 − ${exempt}）× ${rate}` : `紙版：本体価格 × 発行部数 × ${rate}`;
    case "pub_digital": return `電子版：甲の受領額 × ${rate}`;
    default:            return `${conditionUsageLabel(usageType) || "利用許諾"}：甲の受領額 × ${rate}`;
  }
}

export interface InLieuTermsInput {
  /** 対価を初版利用許諾料で払う成果物（原稿、イラスト …）と、仮計算額の配分。 */
  deliverables: Array<{ name: string; amount: number }>;
  /** 初版の算定の基礎（見込み）。 */
  firstEdition: FirstEditionBasis;
  /** 仮計算額（税抜・円）。委託料の行の合計と同じ。空なら firstEditionFee から。 */
  provisionalAmount?: number | null;
  /** 受領から何日以内に本体価格・部数を確定するか（60 以内）。空なら 45。 */
  confirmWithinDays?: number | null;
  /** 支払期日。空なら「本発注書記載の支払期日」。 */
  payOn?: string | null;
  /** 2 版目以降・電子の料率（利用形態ごと）。 */
  laterRates: Array<{ usageType: string; ratePct: number }>;
  /** 2 版目以降の非加算（発行部数の %）。空なら非加算なし。 */
  laterExemptPct?: number | null;
  /** 細目を定める書面の名前。空なら「個別出版条件書」。 */
  detailDocument?: string | null;
  /** 利用許諾条件を載せる出版基本契約（業務委託の基本契約とは別）。 */
  masterAgreement?: { no: string | null; title: string | null } | null;
  /** クレジット表記（A-076）。あれば項を立てる。 */
  creditNotice?: string | null;
  /** 再許諾の可否（A-079）。no=不可 / consent=可（都度の同意） / covered=可（本特約で包括同意）。空なら書かない。 */
  sublicense?: SublicenseMode | null;
}

/** 再許諾の可否。細目（再許諾先・料率・範囲）は個別出版条件書で決める。 */
export type SublicenseMode = "no" | "consent" | "covered";
export const SUBLICENSE_LABEL: Record<SublicenseMode, string> = { no: "不可", consent: "可（都度合意）", covered: "可（包括同意）" };
export function sublicenseModeOf(sublicensable: boolean | null | undefined, consent: string | null | undefined): SublicenseMode | null {
  if (sublicensable === false) return "no";
  if (sublicensable === true) return consent === "covered" ? "covered" : "consent";
  return null;
}

/** 契約の呼び方（「出版基本契約（AGR-2026-0088 出版基本契約）」）。番号も名前も無ければ「出版基本契約」。 */
export function masterAgreementText(agreement: { no: string | null; title: string | null } | null | undefined): string {
  const ref = [String(agreement?.no ?? "").trim(), String(agreement?.title ?? "").trim()].filter(Boolean).join(" ");
  return ref ? `出版基本契約（${ref}）` : "出版基本契約";
}

const jaDate = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日` : iso;
};

/**
 * 発注書の特約（初版の利用許諾料を報酬として支払う旨の特則）。SPECIAL_TERMS の既定値（人が直せる）。
 *
 *   1. 対価は初版利用許諾料。別途の制作報酬は払わない。約款より優先。
 *   2. 算定方法と仮計算額（見込みの根拠）。
 *   3. 受領後○日以内に本体価格・部数を通知し乙の確認を得て確定。下回れば仮計算額。
 *   4. 受領後 60 日以内に確定額を支払。未確定なら仮計算額を払い、差額は確定後 30 日以内。返還不要。
 *   5. 2 版目以降・電子は出版基本契約の個別契約による（式）。制作の委託は約款による。
 *   6. クレジット表記（あるとき）。
 *   7. 受領前の取消・変更は協議の上で相当額。
 *   8. 協議の上で合意した旨の確認。
 */
export function inLieuSpecialTerms(input: InLieuTermsInput): string {
  const names = input.deliverables.map((d) => d.name.trim()).filter(Boolean);
  const subject = names.length > 1 ? `${names.join("および")}の制作` : `${names[0] ?? "成果物"}の制作`;
  const detailDoc = String(input.detailDocument ?? "").trim() || "個別出版条件書";
  const fe = input.firstEdition;
  const provisional = input.provisionalAmount ?? firstEditionFee(fe);
  const breakdown = input.deliverables.length > 1
    ? `（内訳：${input.deliverables.map((d) => `${d.name.trim()} 金${yen(d.amount)}円`).join("、")}）`
    : "";
  const days = input.confirmWithinDays ?? 45;
  const due = input.payOn ? `${jaDate(input.payOn)}` : "本発注書記載の支払期日";
  const master = input.masterAgreement ? masterAgreementText(input.masterAgreement) : null;
  const laterFormulas = input.laterRates.map((r) => royaltyFormulaText(r.usageType, r.ratePct, input.laterExemptPct)).join("、");
  const laterClause = master
    ? `第2版以降の出版および電子版の配信に係る利用許諾料は、甲乙間の${master}に基づく個別契約として締結する${detailDoc}の定めによる${laterFormulas ? `（${laterFormulas}）` : ""}。本特約に定める利用許諾の条件は同契約の個別契約として取り扱い、本制作の委託（成果物の制作・納入・検収）については業務委託基本契約約款による。`
    : `第2版以降の出版および電子版の配信に係る利用許諾料は、甲乙間の${detailDoc}の定めによる${laterFormulas ? `（${laterFormulas}）` : ""}。甲乙間に出版基本契約があるときは、本特約に定める利用許諾の条件と${detailDoc}をその個別契約として取り扱う。本制作の委託（成果物の制作・納入・検収）については業務委託基本契約約款による。`;
  // 再許諾の可否（A-079）。可否と同意の要否は発注時に決め、細目は個別出版条件書で。
  const sublicenseClause = input.sublicense === "no"
    ? "成果物の第三者への再許諾（翻訳出版等）は行わない。"
    : input.sublicense === "consent"
    ? `成果物の第三者への再許諾（翻訳出版等）は、乙の事前の書面による同意を得て行い、その条件（再許諾先・料率・範囲）は${detailDoc}で定める。`
    : input.sublicense === "covered"
    ? `成果物の第三者への再許諾（翻訳出版等）は、本特約により乙の同意を得たものとし、その条件（再許諾先・料率・範囲）は${detailDoc}で定める。`
    : "";
  const credit = String(input.creditNotice ?? "").trim();
  const clauses: string[][] = [
    [`本業務のうち${subject}（以下「本制作」）の対価は、乙が著作権を有する成果物の初版の出版に係る利用許諾料（以下「初版利用許諾料」）とし、別途の制作報酬は支払わない。本制作の対価については、本特約が業務委託基本契約約款に優先する。`],
    [`初版利用許諾料の算定方法は、${firstEditionFormulaText(fe)} とする。本発注書記載の金額（金${yen(provisional)}円。以下「仮計算額」）は、本体価格${fe.price.toLocaleString("ja-JP")}円・初版${fe.copies.toLocaleString("ja-JP")}部の見込みによる仮計算である${breakdown}。`],
    [`甲は、成果物を受領した日から${days}日以内に、本体価格および初版発行部数を乙に書面（電磁的方法を含む）で通知し、乙の確認を得て初版利用許諾料の額を確定する。確定額が仮計算額を下回るときは、仮計算額をもって確定額とする。`],
    [`甲は、成果物を受領した日から60日以内である${due}までに、確定額を支払う。同日までに確定しないときは、同日までに仮計算額を支払い、確定後の差額を確定の日から30日以内に追加して支払う。初版利用許諾料は、初版の発行の有無および時期にかかわらず支払うものとし、乙は返還を要しない。`],
    [laterClause + sublicenseClause],
    ...(credit ? [[`甲は、成果物を利用するに際し、次のクレジット表記を行う。表記の変更は甲乙協議の上で定める。\n　${credit}`]] : []),
    ["甲の都合により、成果物の受領前に本制作の全部または一部を取り消し、または変更する場合、甲は乙と協議の上、履行済みの割合および乙が要した費用を考慮した相当額を支払う。"],
    ["甲および乙は、本特約の対価の定め方が、乙による著作権の留保と利用許諾料の収受を前提として、協議の上で合意されたものであることを確認する。"]
  ];
  return [
    "特約（初版の利用許諾料を報酬として支払う旨の特則）",
    ...clauses.flatMap((lines, i) => ["", `${i + 1}. ${lines[0]}`, ...lines.slice(1)])
  ].join("\n");
}

/**
 * 受領日から 60 日以内か（取適法・フリーランス法の支払期日）。受領日が無ければ確かめない。
 * 60 日目ちょうどは可。
 */
export function withinSixtyDays(receivedOn: string | null | undefined, payOn: string | null | undefined): boolean | null {
  if (!receivedOn || !payOn) return null;
  const a = new Date(`${receivedOn}T00:00:00Z`).getTime();
  const b = new Date(`${payOn}T00:00:00Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  const days = Math.round((b - a) / 86_400_000);
  return days >= 0 && days <= 60;
}
