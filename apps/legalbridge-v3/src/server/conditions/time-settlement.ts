import { DomainError } from "../core/errors.js";

/**
 * 準委任の時間精算（A-073）。
 *
 * 準委任（役務提供）の委託料には 2 つの精算の仕方がある。
 *   固定額・成果物で精算 … 従来どおり。検収書で確認する
 *   時間精算             … 月間包括枠（コアタイム）を持ち、実績時間で精算する。
 *                          枠までは基本委託料、超過は 超過単価 × 時間、未消化は 控除単価 × 時間（無ければ減額なし）。
 *                          検収書の代わりに役務提供完了通知書（service_completion_notice）を出す
 *
 * 条件明細が持つのは「どう精算するか」だけ。実績時間は回ごとの実績（condition_events.hours）に入る。
 * 計算はここ 1 か所（実績入力の差分・通知書の明細・支払の額が同じ式で出る）。
 */
export interface TimeSettlementTerms {
  timeSettlement: boolean;
  /** 月間包括枠（時間）。時間精算のときだけ。 */
  hoursIncluded: number | null;
  /** 超過単価（最小通貨単位／時間）。 */
  overageUnitAmount: number | null;
  /** 控除単価（最小通貨単位／時間）。空なら未消化でも減額しない。 */
  shortfallUnitAmount: number | null;
}

export interface TimeSettlementInput {
  timeSettlement?: boolean | null;
  hoursIncluded?: number | null;
  overageUnitAmount?: number | null;
  shortfallUnitAmount?: number | null;
}

export const NO_TIME_SETTLEMENT: TimeSettlementTerms =
  { timeSettlement: false, hoursIncluded: null, overageUnitAmount: null, shortfallUnitAmount: null };

/** 契約形式が準委任か。「準委任」「Quasi-mandate」のほか「請負／準委任」のように並んだものも。 */
export function isQuasiMandate(contractForm: string | null | undefined): boolean {
  const s = String(contractForm ?? "").trim().toLowerCase();
  return s.includes("準委任") || s.includes("quasi-mandate") || s.includes("quasi mandate");
}

/**
 * 入力を整える。時間精算でなければ 3 つの値は捨てる（持たせない）。
 * 時間精算なら 包括枠（0 より大きい）と 超過単価 が要る。控除単価は任意。
 */
export function normalizeTimeSettlement(input: TimeSettlementInput): TimeSettlementTerms {
  if (!input.timeSettlement) return { ...NO_TIME_SETTLEMENT };
  const hours = input.hoursIncluded ?? null;
  const overage = input.overageUnitAmount ?? null;
  const shortfall = input.shortfallUnitAmount ?? null;
  if (hours === null || !Number.isFinite(hours) || hours <= 0 || hours > 999999) {
    throw new DomainError("VALIDATION", "時間精算は月間包括枠（時間）を入れてください（0 より大きい数）");
  }
  if (overage === null || !Number.isInteger(overage) || overage < 0) {
    throw new DomainError("VALIDATION", "時間精算は超過単価（1 時間あたり）を入れてください");
  }
  if (shortfall !== null && (!Number.isInteger(shortfall) || shortfall < 0)) {
    throw new DomainError("VALIDATION", "控除単価は 0 以上の整数で入れてください（減額しないなら空）");
  }
  return { timeSettlement: true, hoursIncluded: Math.round(hours * 100) / 100, overageUnitAmount: overage, shortfallUnitAmount: shortfall };
}

/** 時間精算の条件か（委託料で time_settlement が立っている）。 */
export const isTimeSettled = (c: { kind?: string | null; timeSettlement?: boolean | null } | null | undefined): boolean =>
  Boolean(c && (c.kind === undefined || c.kind === null || c.kind === "service") && c.timeSettlement === true);

export interface HoursSettlement {
  /** 基本委託料（包括枠の対価）。実績にかかわらず。 */
  baseAmount: number;
  hoursIncluded: number;
  hoursActual: number;
  /** 包括枠に充当した時間（実績と枠の小さいほう）。 */
  hoursApplied: number;
  overageHours: number;
  overageAmount: number;
  shortfallHours: number;
  /** 控除額（正の数）。控除単価が無ければ 0。 */
  shortfallAmount: number;
  /** 基本 + 超過 − 控除。 */
  total: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * 実績時間から精算額を出す。
 *   超過   … (実績 − 枠) × 超過単価（端数は四捨五入）
 *   未消化 … (枠 − 実績) × 控除単価（控除単価が無ければ 0）
 */
export function settleHours(terms: TimeSettlementTerms, baseAmount: number, hoursActual: number | null | undefined): HoursSettlement {
  const included = Number(terms.hoursIncluded ?? 0);
  const actual = hoursActual === null || hoursActual === undefined || !Number.isFinite(Number(hoursActual))
    ? included : Math.max(0, Number(hoursActual));
  const overageHours = round2(Math.max(0, actual - included));
  const shortfallHours = round2(Math.max(0, included - actual));
  const overageAmount = Math.round(overageHours * Number(terms.overageUnitAmount ?? 0));
  const shortfallAmount = terms.shortfallUnitAmount === null || terms.shortfallUnitAmount === undefined
    ? 0 : Math.round(shortfallHours * Number(terms.shortfallUnitAmount));
  const base = Math.round(Number(baseAmount) || 0);
  return {
    baseAmount: base, hoursIncluded: included, hoursActual: round2(actual),
    hoursApplied: round2(Math.min(actual, included)),
    overageHours, overageAmount, shortfallHours, shortfallAmount,
    total: base + overageAmount - shortfallAmount
  };
}

/** 時間の表記。「64 h」「72.5 h」。 */
export const hoursText = (h: number | null | undefined): string =>
  h === null || h === undefined || !Number.isFinite(Number(h)) ? "" : `${Number(h).toLocaleString("ja-JP", { maximumFractionDigits: 2 })} h`;

/**
 * 画面・紙に出す 1 行。「包括枠 64 h／月 200,000 円、超過 3,125 円／h、未消化 3,000 円／h 控除」。
 * 金額は最小通貨単位の整数（円）。他通貨でもそのまま数字で出す。
 */
export function timeSettlementLabel(terms: TimeSettlementTerms, baseAmount: number | null | undefined, unit = "円"): string {
  if (!terms.timeSettlement) return "";
  const n = (v: number | null | undefined) => (v === null || v === undefined ? "—" : Number(v).toLocaleString("ja-JP"));
  const parts = [`包括枠 ${hoursText(terms.hoursIncluded)}／月 ${n(baseAmount)} ${unit}`,
                 `超過 ${n(terms.overageUnitAmount)} ${unit}／h`];
  if (terms.shortfallUnitAmount !== null && terms.shortfallUnitAmount !== undefined) {
    parts.push(`未消化 ${n(terms.shortfallUnitAmount)} ${unit}／h 控除`);
  }
  return parts.join("、");
}
