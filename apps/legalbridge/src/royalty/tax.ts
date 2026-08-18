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
 *   - 租税条約・非居住者・国別レートはV1にも無く、本スライスの対象外。
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

/** 源泉：100万円のしきい値。 */
export const WITHHOLDING_THRESHOLD = 1_000_000;
/** 源泉：しきい値以下の税率（所得税+復興特別所得税）。 */
export const WITHHOLDING_RATE = 0.1021;
/** 源泉：しきい値超過分の税率。 */
export const WITHHOLDING_RATE_OVER = 0.2042;

/**
 * 消費税額 = ceil(税抜 × 税率/100)。税率既定10%。
 */
export function consumptionTax(amountExTax: number, taxRatePct: number = 10): number {
  const base = Number(amountExTax) || 0;
  const rate = Number(taxRatePct) || 0;
  return Math.ceil((base * rate) / 100);
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
}): boolean {
  if (input.formOverride === true) return true;
  if (input.vendorWithholdingEnabled === true) return true;
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
}): PaymentBreakdown {
  const subtotal = Number(input.subtotalExTax) || 0;
  const ctax = consumptionTax(subtotal, input.taxRatePct ?? 10);
  const taxIncluded = subtotal + ctax;
  const wh = withholdingTax(taxIncluded, input.withholdingEnabled);
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
