import type { Adjustments, FeeTerms } from "./calc.js";
import { DomainError } from "../core/errors.js";

/**
 * V3 の条件（最小通貨単位の整数・料率は百万分率）と、
 * 移植した計算エンジン（円などの主単位・料率は %）の橋渡し。
 *
 * 計算そのものは触らない。単位を合わせるだけをここに閉じ込める。
 */

const MINOR_UNITS: Record<string, number> = { JPY: 1, KRW: 1, VND: 1 };
export const minorPerMajor = (currency: string): number => MINOR_UNITS[currency] ?? 100;

export const toMajor = (minor: number | null | undefined, currency: string): number =>
  minor === null || minor === undefined ? 0 : minor / minorPerMajor(currency);

export const toMinor = (major: number | null | undefined, currency: string): number =>
  major === null || major === undefined ? 0 : Math.round(major * minorPerMajor(currency));

/** 百万分率 → %。125000 → 12.5 */
export const ppmToPct = (ppm: number | null | undefined): number =>
  ppm === null || ppm === undefined ? 0 : ppm / 10000;

/** 計算に使う条件の断面。リポジトリが埋める。 */
export interface ConditionEconomics {
  id: number;
  conditionNo: string | null;
  currency: string;
  pricingModel: "fixed" | "unit_rate" | "revenue_rate" | "subscription" | "none";
  ratePpm: number | null;
  unitAmount: number | null;   // 最小通貨単位
  flatAmount: number | null;   // 最小通貨単位
  mgAmount: number | null;     // 最小通貨単位
  agAmount: number | null;     // 最小通貨単位
  taxCategory: "taxable" | "reduced" | "exempt";
}

/** 実績の報告値。画面や取込から来る。金額は最小通貨単位。 */
export interface ReportedResult {
  /** 売上報告型：報告された売上（外貨のこともある）。 */
  salesInput?: number | null;
  intakeCurrency?: string | null;
  fxRate?: number | null;
  /** 数量ベース：製造数・販売数と、うち無償分。 */
  quantity?: number | null;
  sampleQuantity?: number | null;
  /** 歩留率 0..1。検収での減額に使う。 */
  acceptanceRatio?: number | null;
  /** サブスク型：期間数と初期費用（最小通貨単位）。 */
  periodCount?: number | null;
  initialFee?: number | null;
}

export const TAX_RATE_BY_CATEGORY: Record<ConditionEconomics["taxCategory"], number> = {
  taxable: 10, reduced: 8, exempt: 0
};

/**
 * 条件と報告値から、エンジンに渡す料金モデルを組み立てる。
 * 条件の pricing_model が実績の形を決める（画面で選ばせない）。
 */
export function buildFeeTerms(condition: ConditionEconomics, reported: ReportedResult): FeeTerms {
  const currency = condition.currency;
  const rate = ppmToPct(condition.ratePpm);

  switch (condition.pricingModel) {
    case "fixed":
      return {
        type: "fixed",
        unit_price: toMajor(condition.flatAmount, currency),
        quantity: 1
      };

    case "unit_rate": {
      // 基準価格 × 数量 × 料率。単価は条件、数量は報告値。
      const quantity = Number(reported.quantity ?? 0);
      if (!quantity) throw new DomainError("VALIDATION", "数量ベースの条件には数量が必要です");
      return {
        type: "performance",
        base_price: toMajor(condition.unitAmount, currency),
        rate_pct: rate,
        quantity
      };
    }

    case "revenue_rate": {
      // 報告売上に料率。外貨なら手入力レートで円に直してから掛ける。
      const raw = toMajor(reported.salesInput ?? 0, reported.intakeCurrency ?? currency);
      const intake = String(reported.intakeCurrency ?? currency).toUpperCase();
      const base = intake === "JPY"
        ? Math.round(raw)
        : Math.round(raw * Number(reported.fxRate ?? 0));
      return { type: "revenue", base_amount: base, rate_pct: rate };
    }

    case "subscription": {
      const periodCount = Number(reported.periodCount ?? 1);
      return {
        type: "subscription",
        period_amount: toMajor(condition.flatAmount, currency),
        period_count: periodCount,
        initial_fee: toMajor(reported.initialFee ?? 0, currency)
      };
    }

    case "none":
    default:
      throw new DomainError("VALIDATION",
        `条件 ${condition.conditionNo ?? condition.id} は算定方法が未設定のため計算できません`);
  }
}

/** MG は floor、AG は累積消化。消化済み累計は呼び出し側が DB から渡す。 */
export function buildAdjustments(
  condition: ConditionEconomics,
  reported: ReportedResult,
  agConsumedBeforeMinor: number
): Adjustments {
  const currency = condition.currency;
  return {
    acceptance_ratio: reported.acceptanceRatio ?? undefined,
    sample_quantity: reported.sampleQuantity ?? undefined,
    mg_amount: toMajor(condition.mgAmount, currency),
    ag_amount: toMajor(condition.agAmount, currency),
    ag_consumed_before: toMajor(agConsumedBeforeMinor, currency)
  };
}

export const taxRateFor = (condition: ConditionEconomics): number =>
  TAX_RATE_BY_CATEGORY[condition.taxCategory] ?? 10;
