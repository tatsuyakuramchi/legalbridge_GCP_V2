/**
 * 為替換算・売上報告明細の計算（純関数・DB非依存）— Phase 1 スライス9。
 *
 * V1（`LegalBridge_AI_GCP` の `royaltyStatement.tsx` `computeLine`）の多明細
 * （利用許諾料計算書・売上報告ベース）計算を V2 へ忠実移植。
 *
 * 為替：外部レートAPI・TTM取得・レートマスタは無く、**入金日レート（fx_rate）は
 * 手入力**。入金通貨が JPY 以外なら `round(外貨額 × fx_rate)` で円換算する。
 * fx_rate 未入力（0）なら円base=0（呼び出し側UIで警告する前提）。
 *
 * 明細計算：
 *   - 売上報告型（revenue）：base(円) = 円換算後の売上、支払 = ceil(base × 料率/100)。
 *   - 製造型（manufacturing）：billable = max(0, 数量 − sample)、
 *     base(円) = round(単価 × billable)、支払 = ceil(単価 × billable × 料率/100)。
 *     ※支払は丸め前の積から算出（V1踏襲。base は round、支払は raw×率のceil）。
 *
 * 丸め：円換算 base は round、支払は ceil（V1踏襲）。
 */

/**
 * 外貨額を円へ換算する。JPY（大小文字無視）はそのまま round、
 * それ以外は round(amount × fxRate)。foreign かつ fxRate 0 なら 0。
 */
export function convertToJpy(amount: number, currency: string, fxRate: number): number {
  const value = Number(amount) || 0;
  const isForeign = String(currency || "JPY").toUpperCase() !== "JPY";
  if (!isForeign) return Math.round(value);
  const rate = Number(fxRate) || 0;
  return Math.round(value * rate);
}

export type StatementLineInput =
  | {
      method: "revenue";
      salesInput: number;    // 報告売上（intakeCurrency建て）
      intakeCurrency?: string;
      fxRate?: number;
      ratePct: number;
    }
  | {
      method: "manufacturing";
      unitPrice: number;
      qty: number;
      sample?: number;
      ratePct: number;
    };

export type StatementLine = {
  method: "revenue" | "manufacturing";
  salesJpy: number;   // 算定基礎額（円）
  paymentJpy: number; // 支払額（税抜・円）
};

/**
 * 利用許諾料計算書の1明細（売上報告 or 製造ベース）を算定する。
 * V1 `royaltyStatement.tsx` の `computeLine` を移植。
 */
export function computeStatementLine(input: StatementLineInput): StatementLine {
  const ratePct = Number(input.ratePct) || 0;
  if (input.method === "manufacturing") {
    const unitPrice = Number(input.unitPrice) || 0;
    const qty = Number(input.qty) || 0;
    const sample = Number(input.sample) || 0;
    const billable = Math.max(0, qty - sample);
    return {
      method: "manufacturing",
      salesJpy: Math.round(unitPrice * billable),
      paymentJpy: Math.ceil((unitPrice * billable * ratePct) / 100),
    };
  }
  const base = convertToJpy(Number(input.salesInput) || 0, input.intakeCurrency ?? "JPY", input.fxRate ?? 0);
  return {
    method: "revenue",
    salesJpy: base,
    paymentJpy: Math.ceil((base * ratePct) / 100),
  };
}
