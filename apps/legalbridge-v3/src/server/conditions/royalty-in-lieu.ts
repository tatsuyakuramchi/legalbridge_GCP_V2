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

/** 委託料の行の報酬名（台帳の印）。発注書の行は「制作報酬（初版の利用許諾料の算定方法による仮計算額。確定は特約第3項）」と出る。 */
export const IN_LIEU_REWARD_LABEL = "初版利用許諾料";

/**
 * 利用許諾料の価格の基準（A-091）。
 * list=本体価格（定価）/ supply=卸価格（再許諾先への供給価格。KADOKAWA へ卸す形）/ receipts=発注者の受領額（電子など）。
 */
export type PriceBasis = "list" | "supply" | "receipts";
export const PRICE_BASIS_LABEL: Record<PriceBasis, string> =
  { list: "定価（本体価格）", supply: "卸価格（再許諾先への供給価格。運用では使わない）", receipts: "受領した再許諾料 × 料率" };
export function priceBasisOf(value: unknown): PriceBasis | null {
  return value === "list" || value === "supply" || value === "receipts" ? value : null;
}
/** 式に出す価格の言い方。「本体価格（税抜）」「卸価格（KADOKAWA への供給価格・税抜）」「発注者の受領額」。 */
export function priceBasisText(basis: PriceBasis | null | undefined, partyName?: string | null): string {
  if (basis === "supply") return `卸価格（${String(partyName ?? "").trim() ? `${String(partyName).trim()} への` : "再許諾先への"}供給価格・税抜）`;
  if (basis === "receipts") return "発注者の受領額";
  return "本体価格（税抜）";
}

/** 初版の算定の基礎。発注時は見込み、確定後は確定値。 */
export interface FirstEditionBasis {
  /** 本体価格（税抜・円）。価格の基準（priceBasis）が卸価格なら卸価格。 */
  price: number;
  /** 価格の基準（A-091）。空なら本体価格。 */
  priceBasis?: PriceBasis | null;
  /** 卸価格の相手（再許諾先）の名前。式に「KADOKAWA への供給価格」と出す。 */
  partyName?: string | null;
  /** 初版発行部数。 */
  copies: number;
  /** 料率（%）。 */
  ratePct: number;
  /** 非加算部数（献本・見本等）。0／空なら全部数。 */
  exemptCopies?: number | null;
}

/** 初版利用許諾料の計算：本体価格 × （部数 − 非加算）× 率。四捨五入。部数が非加算以下なら 0。 */
export function firstEditionFee(basis: FirstEditionBasis): number {
  // 受領額基準（再許諾料の入金 × 料率）は部数を掛けない。price が見込みの受領額そのもの。A-092
  if (basis.priceBasis === "receipts") {
    const r = basis.price * basis.ratePct / 100;
    return Number.isFinite(r) && r > 0 ? Math.round(r) : 0;
  }
  const copies = Math.max(0, Math.floor(basis.copies) - Math.floor(basis.exemptCopies ?? 0));
  const raw = basis.price * copies * basis.ratePct / 100;
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 0;
}

/** 算定方法の文（「本体価格（税抜）×（初版発行部数 − 献本・見本等の非加算部数100部）× 10％」）。 */
export function firstEditionFormulaText(basis: Pick<FirstEditionBasis, "ratePct" | "exemptCopies" | "priceBasis" | "partyName">): string {
  const exempt = Math.floor(basis.exemptCopies ?? 0);
  if (basis.priceBasis === "receipts") {
    return `発注者が${String(basis.partyName ?? "").trim() ? `${String(basis.partyName).trim()}から` : "再許諾先から"}受領する再許諾料（税抜）× ${pct(basis.ratePct)}％`;
  }
  const price = priceBasisText(basis.priceBasis, basis.partyName);
  return exempt > 0
    ? `${price}×（初版発行部数 − 献本・見本等の非加算部数${exempt.toLocaleString("ja-JP")}部）× ${pct(basis.ratePct)}％`
    : `${price}× 初版発行部数 × ${pct(basis.ratePct)}％`;
}

/** 算定の基礎の短い言い方（明細の仕様・検収の内訳に出す）。「本体価格 1,000円 ×（初版 3,000部 − 献本等 100部）× 10%」 */
export function firstEditionBasisText(basis: FirstEditionBasis, label: "見込み" | "確定" = "見込み"): string {
  const exempt = Math.floor(basis.exemptCopies ?? 0);
  const copies = exempt > 0
    ? `（初版 ${basis.copies.toLocaleString("ja-JP")}部 − 献本等 ${exempt.toLocaleString("ja-JP")}部）`
    : `初版 ${basis.copies.toLocaleString("ja-JP")}部`;
  const price = basis.priceBasis === "supply"
    ? `卸価格 ${basis.price.toLocaleString("ja-JP")}円（${String(basis.partyName ?? "").trim() ? `${String(basis.partyName).trim()} への` : "再許諾先への"}供給価格・税抜）`
    : `本体価格 ${basis.price.toLocaleString("ja-JP")}円（税抜）`;
  if (basis.priceBasis === "receipts") {
    return `算定の基礎（${label}）：受領する再許諾料 ${basis.price.toLocaleString("ja-JP")}円（税抜）× ${pct(basis.ratePct)}%`;
  }
  return `算定の基礎（${label}）：${price}× ${copies} × ${pct(basis.ratePct)}%`;
}

/** 2 版目以降の非加算（発行部数の %）の文。空か 0 なら空文字。 */
export function laterExemptText(pctValue: number | null | undefined): string {
  return pctValue ? `発行部数の${pct(pctValue)}％にあたる献本等の非加算部数` : "";
}

/**
 * 発注書の利用許諾条件の表に出す短い注記。「初版は明細の原稿制作報酬で支払済み（非加算 100部）／2版以降は発行部数の1%を非加算」。
 * 対象の明細が 1 行ならその名前（原稿制作報酬）、複数なら「制作報酬」（対象の行は別に列挙される）。A-103
 */
export function inLieuShortNote(firstExempt: number | null | undefined, laterPct: number | null | undefined,
                                coverName?: string | null): string {
  const reward = String(coverName ?? "").trim() ? `${String(coverName).trim()}報酬` : "制作報酬";
  const first = `初版は明細の${reward}で支払済み${firstExempt ? `（非加算 ${Math.floor(firstExempt).toLocaleString("ja-JP")}部）` : ""}`;
  const later = laterPct ? `2版以降は発行部数の${pct(laterPct)}%を非加算` : "";
  return [first, later].filter(Boolean).join("／");
}

const pct = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2))));
const yen = (n: number) => Math.round(n).toLocaleString("ja-JP");

/** 2 版目以降・電子の算定式。 */
export function royaltyFormulaText(usageType: unknown, ratePct: number, laterExemptPct?: number | null,
                                   priceBasis?: PriceBasis | null, partyName?: string | null): string {
  const rate = `${pct(ratePct)}％`;
  const exempt = laterExemptText(laterExemptPct);
  switch (String(usageType ?? "")) {
    case "pub_print": {
      // 価格の基準（A-091）。空なら本体価格。卸価格なら「卸価格（KADOKAWA への供給価格・税抜）」。
      // 受領額（再許諾料の入金 × 料率）は部数を掛けない（A-092）。
      if (priceBasis === "receipts") return `紙版：発注者の受領額 × ${rate}`;
      const price = priceBasis ? priceBasisText(priceBasis, partyName).replace(/^本体価格（税抜）$/, "本体価格") : "本体価格";
      return exempt ? `紙版：${price} ×（発行部数 − ${exempt}）× ${rate}` : `紙版：${price} × 発行部数 × ${rate}`;
    }
    case "pub_digital": return `電子版：${priceBasis && priceBasis !== "receipts" ? priceBasisText(priceBasis, partyName) : "発注者の受領額"} × ${rate}`;
    default:            return `${conditionUsageLabel(usageType) || "利用許諾"}：${priceBasis && priceBasis !== "receipts" ? priceBasisText(priceBasis, partyName) : "発注者の受領額"} × ${rate}`;
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
  /** 2 版目以降・電子の料率（利用形態ごと）。価格の基準（A-091）があれば式に出す。 */
  laterRates: Array<{ usageType: string; ratePct: number; priceBasis?: PriceBasis | null; partyName?: string | null }>;
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
  /**
   * 併せて締結する条件書（A-080）。pub_terms=出版等利用許諾条件書（作品追加の合意）／
   * license_terms=個別利用許諾条件書（ゲーム）。あれば「本特約の利用許諾の条件はその条件書に当たる」と書く。
   */
  companionDocument?: CompanionDocument | null;
  /** 本制作の業務期間（開始〜納期）。発注書の明細から。空なら「本発注書記載の期間」。 */
  servicePeriod?: { start?: string | null; end?: string | null } | null;
  /** 成果物の利用許諾の期間（紙の利用許諾条件の期間）。空なら「本発注書の利用許諾条件に定める期間」。 */
  licensePeriod?: { start?: string | null; end?: string | null } | null;
}

/** 期間の文。両端が空なら null。片方だけなら「〜」で示す。 */
function periodText(p: { start?: string | null; end?: string | null } | null | undefined): string | null {
  if (!p || (!p.start && !p.end)) return null;
  if (p.start && p.end) return `${jaDate(p.start)}から${jaDate(p.end)}まで`;
  return p.start ? `${jaDate(p.start)}から（終期の定めなし）` : `${jaDate(p.end!)}まで`;
}

/**
 * 条件書（出版等利用許諾条件書・個別利用許諾条件書）の備考に写す 1 文（A-089）。
 * 初版分は発注書の報酬として支払済みで、条件書の対象は第2版以降・電子だと分かるようにする。
 */
export function inLieuPaidNote(basis: Partial<FirstEditionBasis> | null | undefined): string {
  const fe = basis && basis.price && basis.copies && basis.ratePct
    ? { price: Number(basis.price), copies: Number(basis.copies), ratePct: Number(basis.ratePct), exemptCopies: basis.exemptCopies ?? null,
        priceBasis: basis.priceBasis ?? null, partyName: basis.partyName ?? null }
    : null;
  const calc = fe ? `（算定：${firstEditionBasisText(fe, "見込み").replace(/^算定の基礎（見込み）：/, "")}）` : "";
  return `初版の出版に係る利用許諾料は、発注書の制作報酬（初版利用許諾料）として支払済み${calc}。本条件書の料率は第2版以降の出版および電子版に適用する。`;
}

/** 発注書と併せて出す条件書。ひな形は既存のもの。 */
export type CompanionDocument = "pub_terms" | "license_terms";
export const COMPANION_LABEL: Record<CompanionDocument, string> = { pub_terms: "出版等利用許諾条件書", license_terms: "個別利用許諾条件書" };
/** ひな形キー → 条件書の種類。条件書でなければ null。 */
export function companionOfTemplate(templateKey: unknown): CompanionDocument | null {
  const k = String(templateKey ?? "");
  if (k === "pub_license_terms_v3" || k === "pub_license_terms_v3_annex") return "pub_terms";
  if (k === "individual_license_terms_v3" || k === "individual_license_terms_v4") return "license_terms";
  return null;
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
 *   3. 受領後○日以内に本体価格・部数を通知し受注者の確認を得て確定。下回れば仮計算額。
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
  const laterFormulas = input.laterRates.map((r) => royaltyFormulaText(r.usageType, r.ratePct, input.laterExemptPct, r.priceBasis, r.partyName)).join("、");
  const laterClause = master
    ? `第2版以降の出版および電子版の配信に係る利用許諾料は、発注者と受注者の間の${master}に基づく個別契約として締結する${detailDoc}の定めによる${laterFormulas ? `（${laterFormulas}）` : ""}。本特約に定める利用許諾の条件は同契約の個別契約として取り扱い、本制作の委託（成果物の制作・納入・検収）については業務委託基本契約約款による。`
    : `第2版以降の出版および電子版の配信に係る利用許諾料は、発注者と受注者の間の${detailDoc}の定めによる${laterFormulas ? `（${laterFormulas}）` : ""}。発注者と受注者の間に出版基本契約があるときは、本特約に定める利用許諾の条件と${detailDoc}をその個別契約として取り扱う。本制作の委託（成果物の制作・納入・検収）については業務委託基本契約約款による。`;
  // 再許諾の可否（A-079）。可否と同意の要否は発注時に決め、細目は個別出版条件書で。
  const sublicenseClause = input.sublicense === "no"
    ? "成果物の第三者への再許諾（翻訳出版等）は行わない。"
    : input.sublicense === "consent"
    ? `成果物の第三者への再許諾（翻訳出版等）は、受注者の事前の書面による同意を得て行い、その条件（再許諾先・料率・範囲）は${detailDoc}で定める。`
    : input.sublicense === "covered"
    ? `成果物の第三者への再許諾（翻訳出版等）は、本特約により受注者の同意を得たものとし、その条件（再許諾先・料率・範囲）は${detailDoc}で定める。`
    : "";
  // 併せて締結する条件書（A-080）。発注書の利用許諾条件はその条件書に当たる、と対応を書く。
  const companionClause = input.companionDocument
    ? (input.companionDocument === "pub_terms"
      ? `本特約および本発注書の利用許諾条件に定める利用許諾の条件は、本発注書と併せて締結する出版等利用許諾条件書（${master ?? "出版基本契約"}に基づく作品追加の合意）に定める条件に当たり、同条件書が締結されたときは、利用許諾に関する事項は同条件書による。`
      : "本特約および本発注書の利用許諾条件に定める利用許諾の条件は、本発注書と併せて締結する個別利用許諾条件書に定める条件に当たり、同条件書が締結されたときは、利用許諾に関する事項は同条件書による。")
    : "";
  const credit = String(input.creditNotice ?? "").trim();
  const clauses: string[][] = [
    [`本業務のうち${subject}（以下「本制作」）の対価（制作報酬）は、受注者が著作権を有する成果物の初版の出版に係る利用許諾料の算定方法により算定した額（以下「初版利用許諾料」）とし、当該報酬には成果物の初版の出版に係る利用許諾の対価を含む。発注者は、これと別に制作報酬または初版の利用許諾料を支払わない。本制作の業務期間は${periodText(input.servicePeriod) ?? "本発注書記載の期間（納期まで）"}とし、成果物の利用許諾の期間は${periodText(input.licensePeriod) ?? "本発注書の利用許諾条件に定める期間"}とする。本制作の対価については、本特約が業務委託基本契約約款に優先する。`],
    [`初版利用許諾料の算定方法は、${firstEditionFormulaText(fe)} とする。本発注書記載の金額（金${yen(provisional)}円。以下「仮計算額」）は、${fe.priceBasis === "receipts" ? `受領する再許諾料${fe.price.toLocaleString("ja-JP")}円` : `${fe.priceBasis === "supply" ? "卸価格" : "本体価格"}${fe.price.toLocaleString("ja-JP")}円・初版${fe.copies.toLocaleString("ja-JP")}部`}の見込みによる仮計算である${breakdown}。`],
    [`発注者は、成果物を受領した日から${days}日以内に、${fe.priceBasis === "receipts" ? "受領する再許諾料の額" : `${fe.priceBasis === "supply" ? "卸価格" : "本体価格"}および初版発行部数`}を受注者に書面（電磁的方法を含む）で通知し、受注者の確認を得て初版利用許諾料の額を確定する。確定した額が仮計算額より多いときは確定した額を、確定した額が仮計算額より少ないときは仮計算額を、それぞれ支払額とする（仮計算額より減額しない）。`],
    [`発注者は、成果物を受領した日から60日以内である${due}までに、前項の支払額を支払う。同日までに確定していないときは、同日までに仮計算額を支払い、確定した額が仮計算額より多いときは、その差額を確定の日から30日以内に追加して支払う。初版利用許諾料は、初版の発行の有無および時期にかかわらず支払うものとし、受注者は返還を要しない。`],
    [laterClause + sublicenseClause + companionClause],
    ...(credit ? [[`発注者は、成果物を利用するに際し、次のクレジット表記を行う。表記の変更は発注者と受注者の協議の上で定める。\n　${credit}`]] : []),
    ["発注者の都合により、成果物の受領前に本制作の全部または一部を取り消し、または変更する場合、発注者は受注者と協議の上、履行済みの割合および受注者が要した費用を考慮した相当額を支払う。"],
    ["発注者および受注者は、本特約の対価の定め方が、受注者による著作権の留保と利用許諾料の収受を前提として、協議の上で合意されたものであることを確認する。"]
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
