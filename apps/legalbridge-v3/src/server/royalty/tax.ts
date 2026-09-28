// V2 から移植（apps/legalbridge/src/royalty/tax.ts）。純関数・DB非依存。
// 源泉徴収の段階税率と丸め（各段 floor）は法令準拠なので変更しない。
/**
 * 源泉徴収・消費税エンジン（純関数・DB非依存）— Phase 1 スライス3。
 *
 * V1（`LegalBridge_AI_GCP` の `excelService.buildFromFormData` および
 * `paymentExportService.resolveVendorForExcel`）の税計算を V2 へ忠実移植。
 *
 * 源泉徴収（所得税法204条・国内居住者一律）：
 *   - 課税ベースは **税込額**（税抜小計 + 消費税）。
 *   - 100万円以下：`floor(税込 × 10.21%)`
 *   - 100万円超過分：`floor(1,000,000 × 10.21%) + floor((税込 − 1,000,000) × 20.42%)`
 *   - 非居住者（A-057）は withholdingFor を使う：国内法の一律 20.42%（所得税法 212 条）、
 *     租税条約の書類が支払日までにあれば条約の税率。海外発注書の約款 6.2・6.4 条と同じ。
 *
 * 源泉対象の判定：
 *   - `vendors.withholding_enabled === true`、または
 *   - 個人取引先（`entity_type` = "個人"/"individual"）は未設定でも対象、または
 *   - フォームの明示上書き（`VENDOR_WITHHOLDING_ENABLED === true`）。
 *
 * 消費税：`ceil(税抜 × 税率/100)`（整数算・浮動小数点対策、Legal合意の切り上げ）。
 *
 * 丸め注記：消費税は ceil、源泉は各段 floor（V1踏襲）。源泉税額はDBに永続化されず
 * 支払報告の導出値（物理列 `payments.withholding_tax` は別途存在）。
 */
import { taxOf } from "./rounding.js";

/** 源泉：100万円のしきい値。 */
export const WITHHOLDING_THRESHOLD = 1_000_000;
/** 源泉：しきい値以下の税率（所得税+復興特別所得税）。 */
export const WITHHOLDING_RATE = 0.1021;
/** 源泉：しきい値超過分の税率。 */
export const WITHHOLDING_RATE_OVER = 0.2042;

/**
 * 消費税額 = 切り捨て(税抜 × 税率/100)。税率既定10%。
 *
 * 下の源泉徴収も切り捨てだが、あちらは所得税法の定めで、こちらは社内の
 * 決まり。同じ丸め方でも由来が違うので別々に持つ。
 */
export function consumptionTax(amountExTax: number, taxRatePct: number = 10): number {
  return taxOf(amountExTax, taxRatePct);
}

/**
 * 源泉対象か否かを解決する。以下のいずれかが真なら対象：
 *   - フォームの明示上書き（formOverride）
 *   - 取引先マスタの withholding_enabled
 *   - 個人取引先（entity_type = 個人/individual）
 * いずれも「対象化（true化）」のみで、false へ強制する経路はV1に無い。
 */
export function resolveWithholdingEnabled(input: {
  vendorWithholdingEnabled?: boolean | null;
  entityType?: string | null;
  formOverride?: boolean | null;
  /** 非居住者は「個人なら自動で対象」にしない（海外で行う役務は原則として源泉が要らない）。 */
  residency?: string | null;
}): boolean {
  if (input.formOverride === true) return true;
  if (input.vendorWithholdingEnabled === true) return true;
  if (input.residency === "non_resident") return false;
  const entity = String(input.entityType ?? "").toLowerCase();
  if (entity === "個人" || entity === "individual") return true;
  return false;
}

/**
 * 源泉税額を算出する（課税ベース = 税込額）。
 * 非対象または税込0以下なら0。100万円超過は二段階 floor。
 */
export function withholdingTax(taxIncludedAmount: number, enabled: boolean): number {
  const base = Number(taxIncludedAmount) || 0;
  if (!enabled || base <= 0) return 0;
  if (base <= WITHHOLDING_THRESHOLD) {
    return Math.floor(base * WITHHOLDING_RATE);
  }
  return (
    Math.floor(WITHHOLDING_THRESHOLD * WITHHOLDING_RATE) +
    Math.floor((base - WITHHOLDING_THRESHOLD) * WITHHOLDING_RATE_OVER)
  );
}

/** 非居住者の源泉の国内法の税率（%）。所得税 20% ＋ 復興特別所得税（2.1%）。 */
export const NON_RESIDENT_RATE_PCT = 20.42;

/** 源泉の税率を決める取引先の情報（A-057）。 */
export interface WithholdingParty {
  residency?: string | null;
  treatyRatePct?: number | null;
  /** 租税条約の届出書・居住者証明書を受け取った日（YYYY-MM-DD）。 */
  treatyDocsReceivedOn?: string | null;
}

export interface WithholdingResult {
  amount: number;
  /** 使った税率（%）。居住者の段階税率は null（10.21%／20.42% の二段）。 */
  ratePct: number | null;
  basis: "none" | "resident" | "non_resident_domestic" | "treaty";
}

/**
 * 源泉税額（居住者・非居住者の両方）。課税ベースは税込額（海外は税込・内税なのでそのまま）。
 *
 *   居住者       … これまでどおり 10.21%（100万円超は 20.42%）の二段 floor
 *   非居住者     … 国内法の一律 20.42%。租税条約の税率があり、書類を支払日までに（支払日が
 *                   分からなければ今日までに）受け取っていれば条約の税率（0% もありうる）
 * 丸めは floor。税率はベーシスポイントの整数で掛ける（浮動小数点の誤差で 1 円ずれないように）。
 */
export function withholdingFor(
  taxIncludedAmount: number, enabled: boolean, party: WithholdingParty | null | undefined,
  payOn?: string | null, today: string = new Date().toISOString().slice(0, 10)
): WithholdingResult {
  const base = Number(taxIncludedAmount) || 0;
  if (!enabled || base <= 0) return { amount: 0, ratePct: null, basis: "none" };
  if (party?.residency !== "non_resident") {
    return { amount: withholdingTax(base, true), ratePct: null, basis: "resident" };
  }
  const treaty = party.treatyRatePct;
  const docsOn = String(party.treatyDocsReceivedOn ?? "").slice(0, 10);
  const by = String(payOn ?? "").slice(0, 10) || today;
  const useTreaty = treaty !== null && treaty !== undefined && Number.isFinite(Number(treaty))
    && Boolean(docsOn) && docsOn <= by;
  const ratePct = useTreaty ? Number(treaty) : NON_RESIDENT_RATE_PCT;
  const bp = Math.round(ratePct * 100);
  return { amount: Math.floor((base * bp) / 10000), ratePct, basis: useTreaty ? "treaty" : "non_resident_domestic" };
}

/** 取引先の行から、源泉の税率を決める情報（A-057）を取り出す。 */
export function withholdingPartyOf(row: Record<string, any>): WithholdingParty {
  const on = row.treaty_docs_received_on;
  return {
    residency: row.residency ?? null,
    treatyRatePct: row.treaty_rate_pct === null || row.treaty_rate_pct === undefined ? null : Number(row.treaty_rate_pct),
    treatyDocsReceivedOn: on === null || on === undefined ? null
      : on instanceof Date ? on.toISOString().slice(0, 10) : String(on).slice(0, 10)
  };
}

export type PaymentBreakdown = {
  subtotalExTax: number;   // 税抜小計
  consumptionTax: number;  // 消費税
  taxIncluded: number;     // 税込（源泉の課税ベース）
  withholdingTax: number;  // 源泉税
  afterTax: number;        // 税引後（税込 − 源泉）
  netTransfer: number;     // 差引振込額（税引後 + 立替金）
};

/**
 * 利用許諾料計算書の支払内訳（税抜小計 → +消費税 → 税込 → −源泉 → +立替 → 振込額）。
 * V1 `excelService.buildFromFormData` の royalty パス（税抜小計+消費税基準）を移植。
 * 立替金（reimbursementIncTax）は税込で加算する。
 */
export function computeRoyaltyPayment(input: {
  subtotalExTax: number;
  taxRatePct?: number;
  withholdingEnabled: boolean;
  reimbursementIncTax?: number;
  /** 非居住者と租税条約（A-057）。無ければ居住者として計算する。 */
  withholdingParty?: WithholdingParty | null;
  payOn?: string | null;
}): PaymentBreakdown {
  const subtotal = Number(input.subtotalExTax) || 0;
  const ctax = consumptionTax(subtotal, input.taxRatePct ?? 10);
  const taxIncluded = subtotal + ctax;
  const wh = withholdingFor(taxIncluded, input.withholdingEnabled, input.withholdingParty, input.payOn).amount;
  const afterTax = taxIncluded - wh;
  const reimbursement = Number(input.reimbursementIncTax) || 0;
  return {
    subtotalExTax: subtotal,
    consumptionTax: ctax,
    taxIncluded,
    withholdingTax: wh,
    afterTax,
    netTransfer: afterTax + reimbursement,
  };
}
