/**
 * 再許諾料の受領・分配 計算（純関数・DB非依存）— Phase 1（債権/請求の土台）。
 *
 * V1 `services/api/src/routes/workModel.ts` の `computeRoyalty` /
 * `resolveDistribution` を V2 へ忠実移植。サブライセンサーとして受領した
 * 再許諾料と、上流ライセンサーへの分配額を算定する。
 *
 * 数量ベース判定：`calc_type ∈ {BASE_QTY_RATE, SUPPLY_QTY}` または
 *   `basis === "manufacturing"`。
 * 受領再許諾料：数量ベース = 報告数量 × 単価 × 料率、非数量 = 報告売上 × 料率。
 * 分配（上流支払）：基準額 × 個数 × 親ライセンスイン料率。基準額/個数は
 *   スマート既定（数量ベース=単価×報告数量 / 権利許諾=受領再許諾料×1）＋手動上書き。
 * 丸め：小数2桁（round(x×100)/100）。V1踏襲。
 */

const round2 = (value: number) => Math.round(value * 100) / 100;

export type ReceiptCondition = {
  calcType?: string | null;
  basis?: string | null;
  ratePct?: number | null;
  unitPrice?: number | null;
};

export type ReceiptReport = {
  reportedSales?: number | null;
  reportedQuantity?: number | null;
};

/** 数量ベース（製造/供給数×単価×料率）か否か。 */
export function isQtyBased(cond: ReceiptCondition): boolean {
  const calcType = String(cond?.calcType ?? "").toUpperCase();
  return ["BASE_QTY_RATE", "SUPPLY_QTY"].includes(calcType) || cond?.basis === "manufacturing";
}

/** 受領再許諾料（税抜）を算定する。 */
export function computeReceiptRoyalty(cond: ReceiptCondition, report: ReceiptReport): number {
  const rate = Number(cond?.ratePct) || 0;
  const base = isQtyBased(cond)
    ? (Number(report.reportedQuantity) || 0) * (Number(cond?.unitPrice) || 0)
    : Number(report.reportedSales) || 0;
  return round2(base * (rate / 100));
}

export type DistributionInput = {
  cond: ReceiptCondition;
  report: ReceiptReport;
  /** 受領記録に保存済みの受領再許諾料（基準額の既定に使う）。 */
  computedRoyaltyExTax?: number | null;
  /** 実受領額（computedが無い場合の基準額フォールバック）。 */
  receivedAmount?: number | null;
  /** 親ライセンスイン料率（%）。null なら分配額は算定不能（null）。 */
  parentRatePct?: number | null;
  /** 基準額の手動上書き。 */
  baseOverride?: number | null;
  /** 個数の手動上書き。 */
  qtyOverride?: number | null;
};

export type DistributionResult = {
  base: number;
  qty: number;
  distribution: number | null; // 親料率不明なら null
};

/**
 * 上流ライセンサーへの分配額を算定する。
 * 分配 = 基準額 × 個数 × 親料率。基準額/個数は明示値優先、無ければスマート既定。
 */
export function resolveDistribution(input: DistributionInput): DistributionResult {
  const { cond, report } = input;
  const qtyBased = isQtyBased(cond);

  let base = input.baseOverride == null ? null : Number(input.baseOverride);
  let qty = input.qtyOverride == null ? null : Number(input.qtyOverride);

  if (base == null) {
    if (qtyBased) {
      base = Number(cond?.unitPrice) || 0;                                  // 卸値（単価）
      if (qty == null) qty = Number(report.reportedQuantity ?? 1) || 1;      // 販売数
    } else {
      base = Number(input.computedRoyaltyExTax) || Number(input.receivedAmount) || 0; // 受領再許諾料
      if (qty == null) qty = 1;                                             // 権利許諾は個数1
    }
  }
  if (qty == null) qty = 1;

  const parentRate = input.parentRatePct == null ? null : Number(input.parentRatePct);
  const distribution = parentRate != null ? round2(base * qty * (parentRate / 100)) : null;
  return { base, qty, distribution };
}
