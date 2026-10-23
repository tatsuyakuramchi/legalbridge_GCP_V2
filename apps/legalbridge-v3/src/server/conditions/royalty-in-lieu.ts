import { conditionUsageLabel } from "../core/condition-usage.js";

/**
 * 制作対価を利用許諾料で払う発注（A-075。T17）。
 *
 * 原稿・イラストなど受注者帰属の成果物の制作を、別途の制作報酬ではなく利用許諾料
 * （印税）で払う。委託料の行を 0 円にすると、印税そのものが委託代金と評価されて
 * 取適法・フリーランス法の 3 点（受領後 60 日以内の支払・買いたたき・一方的な代金
 * 決定）に当たるので、「保証利用許諾料」を委託料の行の確定額にし、利用許諾条件の
 * MG と同じ額にする。料率型の利用許諾料は、その超過分だけ計算書で払う。
 *
 * ここは純関数（DB 非依存）。画面の下書きとサーバの登録・発注書の特約が同じ文を使う。
 */

/** 委託料の行の報酬名。紙は「保証利用許諾料（利用許諾料は別途）」と出る。 */
export const IN_LIEU_REWARD_LABEL = "保証利用許諾料";

/**
 * 印税対象外（献本等）。初版は部数、2 版目以降は発行部数の割合。どちらも案件で変えられる。
 * 空（null）はその版に対象外なし。
 */
export interface RoyaltyExemptRule {
  firstEditionCopies: number | null;
  laterEditionPct: number | null;
}
export const DEFAULT_ROYALTY_EXEMPT: RoyaltyExemptRule = { firstEditionCopies: 100, laterEditionPct: 1 };

/**
 * その版の印税対象外の部数。初版（edition=1）は定めた部数、2 版目以降は発行部数 × 割合（切り捨て）。
 * 発行部数を超える対象外は発行部数まで。
 */
export function exemptCopiesFor(rule: RoyaltyExemptRule | null | undefined, edition: number, printed: number): number {
  if (!rule || !Number.isFinite(printed) || printed <= 0) return 0;
  const raw = edition <= 1
    ? Number(rule.firstEditionCopies ?? 0)
    : Math.floor(printed * Number(rule.laterEditionPct ?? 0) / 100);
  return Math.max(0, Math.min(printed, Math.floor(raw)));
}

/** 対象外の定めの文。どちらも空なら空文字（特約に項を立てない）。 */
export function exemptRuleText(rule: RoyaltyExemptRule | null | undefined): string {
  if (!rule) return "";
  const parts: string[] = [];
  if (rule.firstEditionCopies !== null && rule.firstEditionCopies !== undefined && rule.firstEditionCopies > 0) {
    parts.push(`初版は${rule.firstEditionCopies.toLocaleString("ja-JP")}部`);
  }
  if (rule.laterEditionPct !== null && rule.laterEditionPct !== undefined && rule.laterEditionPct > 0) {
    parts.push(`${rule.firstEditionCopies ? "2版目以降は" : ""}発行部数の${pct(rule.laterEditionPct)}％`);
  }
  if (!parts.length) return "";
  return `${parts.join("、")}を献本等として印税の対象外とする`;
}

/** 発注書の利用許諾条件の表に出す短い言い方（「対象外：初版100部／2版以降1%」）。 */
export function exemptRuleShort(rule: RoyaltyExemptRule | null | undefined): string {
  if (!rule) return "";
  const parts: string[] = [];
  if (rule.firstEditionCopies) parts.push(`初版${rule.firstEditionCopies.toLocaleString("ja-JP")}部`);
  if (rule.laterEditionPct) parts.push(`${rule.firstEditionCopies ? "2版以降" : ""}${pct(rule.laterEditionPct)}%`);
  return parts.length ? `対象外：${parts.join("／")}` : "";
}

const pct = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2))));
const yen = (n: number) => Math.round(n).toLocaleString("ja-JP");

/** 利用形態ごとの料率の算定式。出版（紙）は本体価格 × 発行部数、電子は甲の受領額。 */
export function royaltyFormulaText(usageType: unknown, ratePct: number): string {
  const rate = `${pct(ratePct)}％`;
  switch (String(usageType ?? "")) {
    case "pub_print":   return `紙版：本体価格 × 発行部数 × ${rate}`;
    case "pub_digital": return `電子版：甲の受領額 × ${rate}`;
    default:            return `${conditionUsageLabel(usageType) || "利用許諾"}：甲の受領額 × ${rate}`;
  }
}

export interface InLieuTermsInput {
  /** 対価を利用許諾料で払う成果物の名前（原稿、イラスト …）。明細の品目名。 */
  deliverables: Array<{ name: string; amount: number }>;
  /** 利用形態ごとの料率。 */
  rates: Array<{ usageType: string; ratePct: number }>;
  /** 保証利用許諾料（税抜・円）。委託料の行の合計と同じ。 */
  guaranteeAmount: number;
  /** 支払期日。空なら「本発注書記載の支払期日」。 */
  payOn?: string | null;
  exempt?: RoyaltyExemptRule | null;
  /** 細目を定める書面の名前。空なら「個別出版条件書」。 */
  detailDocument?: string | null;
  /**
   * 利用許諾条件を載せる出版基本契約（業務委託の基本契約とは別）。あれば、利用許諾の条件と
   * 個別出版条件書はその個別契約として扱う旨を書く。無ければ「出版基本契約があるときは」の形。
   */
  masterAgreement?: { no: string | null; title: string | null } | null;
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
 * 発注書の特約（原稿制作等の対価）の文。発注書の SPECIAL_TERMS の既定値になる（人が直せる）。
 *
 *   1. 別途の制作報酬を払わず、利用許諾料をもって対価とする。約款より優先。
 *   2. 算定方法（料率・保証利用許諾料・対象外）。細目は個別出版条件書。
 *   3. 保証利用許諾料は受領後 60 日以内の支払期日までに払い、返還不要。
 *   4. 超過分の支払。保証利用許諾料は既払いとして扱う（充当）。
 *   5. 受領前の取消・変更は協議の上で相当額。
 *   6. 協議の上で合意した旨の確認。
 */
export function inLieuSpecialTerms(input: InLieuTermsInput): string {
  const names = input.deliverables.map((d) => d.name.trim()).filter(Boolean);
  const subject = names.length > 1 ? `${names.join("および")}の制作` : `${names[0] ?? "成果物"}の制作`;
  const detailDoc = String(input.detailDocument ?? "").trim() || "個別出版条件書";
  const exempt = exemptRuleText(input.exempt);
  const formulas = input.rates.map((r) => `　・${royaltyFormulaText(r.usageType, r.ratePct)}`);
  const breakdown = input.deliverables.length > 1
    ? `（内訳：${input.deliverables.map((d) => `${d.name.trim()} 金${yen(d.amount)}円`).join("、")}）`
    : "";
  const due = input.payOn ? `${jaDate(input.payOn)}` : "本発注書記載の支払期日";
  // 出版基本契約があれば、利用許諾の条件と個別出版条件書はその個別契約（業務委託の基本契約とは別）。
  const master = input.masterAgreement ? masterAgreementText(input.masterAgreement) : null;
  const detailClause = master
    ? `細目は、甲乙間の${master}に基づく個別契約として締結する${detailDoc}で定める。`
    : `細目は甲乙間の${detailDoc}で定める（甲乙間に出版基本契約があるときは、その個別契約として締結する）。`;
  const contractClause = master
    ? `本特約に定める利用許諾の条件および${detailDoc}は、${master}の個別契約として取り扱い、本特約および${detailDoc}に定めのない事項は同契約の定めによる。本制作の委託（成果物の制作・納入・検収）については、業務委託基本契約約款による。`
    : `本特約に定める利用許諾の条件および${detailDoc}は、甲乙間に出版基本契約があるときはその個別契約として取り扱い、定めのない事項は同契約の定めによる。本制作の委託（成果物の制作・納入・検収）については、業務委託基本契約約款による。`;
  return [
    "特約（制作対価を利用許諾料で支払う旨の特則）",
    "",
    `1. 本業務のうち${subject}（以下「本制作」）については、乙に別途の制作報酬を支払わず、乙が著作権を有する成果物の利用許諾に対する利用許諾料（以下「印税」）をもってその対価とする。本制作の対価については、本特約が業務委託基本契約約款に優先する。`,
    "",
    `2. 印税の算定方法は次のとおりとし、${detailClause}`,
    ...formulas,
    `　・保証利用許諾料：金${yen(input.guaranteeAmount)}円（税抜）${breakdown}`,
    ...(exempt ? [`　・${exempt}。`] : []),
    "",
    `3. ${contractClause}`,
    "",
    `4. 甲は、成果物を受領した日から60日以内である${due}までに、保証利用許諾料を支払う。保証利用許諾料は、成果物の発行の有無および時期にかかわらず支払うものとし、乙は返還を要しない。`,
    "",
    `5. 第2項により算定した印税の累計額が保証利用許諾料の額を超えたときは、甲はその超過額を${detailDoc}の定めにより支払う。保証利用許諾料は、この超過額の算定において既払いの印税として扱う。`,
    "",
    "6. 甲の都合により、成果物の受領前に本制作の全部または一部を取り消し、または変更する場合、甲は乙と協議の上、履行済みの割合および乙が要した費用を考慮した相当額を支払う。",
    "",
    "7. 甲および乙は、本特約の対価の定め方が、乙による著作権の留保と印税の収受を前提として、協議の上で合意されたものであることを確認する。"
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
