import { DomainError } from "../core/errors.js";

/**
 * 決済の型（A-071）。条件明細が「この取引は何回払うものか」を持つ。
 *
 * 予定明細（condition_schedules）は 1 行＝1 回の置き場で、何回あってよいかは
 * これまで決まりが無かった。一回きりの業務委託でも行を足せば 2 枚目の検収書が
 * 作れ、製造のたびに回る許諾は終了日を過ぎても回れた。型を持たせて、回を
 * 立ててよいかを条件から判定する。
 *
 *   once        … 一回きり。1 回で終わる（成果物ありの業務委託、買い切り）
 *   fixed_count … 回数固定。N 回（着手・中間・納品の 3 回払い、分割払い）
 *   term_bound  … 期間で決まる。契約期間 ÷ 周期（顧問・保守、時限式の許諾料）
 *   open        … 回数無制限。出来事のたび（製造・増刷の許諾料、OEM）。
 *                 契約期間内か、終了後の猶予（既定 60 日）内だけ回を立てられる
 *
 * 起点（schedules.trigger_kind＝何をもって 1 回とするか）とは別の軸。
 * 計算書の出し方（statement_timing）は型から導けるので、将来この型に寄せる。
 */
export type SettlementMode = "once" | "fixed_count" | "term_bound" | "open";
export type SettlementCycle = "month" | "quarter" | "half_year" | "year";

export const SETTLEMENT_MODES: SettlementMode[] = ["once", "fixed_count", "term_bound", "open"];
export const SETTLEMENT_CYCLES: SettlementCycle[] = ["month", "quarter", "half_year", "year"];

export const SETTLEMENT_MODE_LABEL: Record<SettlementMode, string> = {
  once: "一回きり", fixed_count: "回数固定", term_bound: "期間で決まる", open: "回数無制限"
};
export const SETTLEMENT_CYCLE_LABEL: Record<SettlementCycle, string> = {
  month: "毎月", quarter: "四半期ごと", half_year: "半年ごと", year: "毎年"
};
export const SETTLEMENT_CYCLE_MONTHS: Record<SettlementCycle, number> = {
  month: 1, quarter: 3, half_year: 6, year: 12
};

/** 終了後の猶予の既定（日）。回数無制限と期間で決まる型に効く。 */
export const SETTLEMENT_GRACE_DAYS_DEFAULT = 60;

export interface SettlementRule {
  mode: SettlementMode | null;
  /** 回数固定の N。 */
  count: number | null;
  /** 期間で決まるときの周期。 */
  cycle: SettlementCycle | null;
  /** 終了後の猶予（日）。空は既定（60）。 */
  graceDays: number | null;
}

export interface SettlementRuleInput {
  settlementMode?: SettlementMode | null;
  settlementCount?: number | null;
  settlementCycle?: SettlementCycle | null;
  settlementGraceDays?: number | null;
}

export const isSettlementMode = (v: unknown): v is SettlementMode =>
  typeof v === "string" && (SETTLEMENT_MODES as string[]).includes(v);
export const isSettlementCycle = (v: unknown): v is SettlementCycle =>
  typeof v === "string" && (SETTLEMENT_CYCLES as string[]).includes(v);

/**
 * 入力を型に合わせて整える。型に要らない値は捨て、要る値が無ければ断る。
 *   回数固定 … count が要る（2 以上。1 回なら一回きり）
 *   期間で決まる … cycle が要る
 *   一回きり … count・cycle・猶予は持たない
 */
export function normalizeSettlementRule(input: SettlementRuleInput): SettlementRule {
  const mode = input.settlementMode ?? null;
  if (mode === null) return { mode: null, count: null, cycle: null, graceDays: null };
  if (!isSettlementMode(mode)) throw new DomainError("VALIDATION", `決済の型が不正です: ${String(mode)}`);
  const count = input.settlementCount ?? null;
  const cycle = input.settlementCycle ?? null;
  const grace = input.settlementGraceDays ?? null;
  if (grace !== null && (!Number.isInteger(grace) || grace < 0 || grace > 3650)) {
    throw new DomainError("VALIDATION", "終了後の猶予は 0〜3650 日で入れてください");
  }
  switch (mode) {
    case "once":
      return { mode, count: null, cycle: null, graceDays: null };
    case "fixed_count":
      if (count === null || !Number.isInteger(count) || count < 2 || count > 1000) {
        throw new DomainError("VALIDATION", "回数固定は回数（2 回以上）を入れてください。1 回なら「一回きり」にします");
      }
      return { mode, count, cycle: null, graceDays: null };
    case "term_bound":
      if (!isSettlementCycle(cycle)) {
        throw new DomainError("VALIDATION", "期間で決まる型は周期（毎月・四半期・半年・毎年）を選んでください");
      }
      return { mode, count: null, cycle, graceDays: grace };
    case "open":
      return { mode, count: null, cycle: null, graceDays: grace };
  }
}

/**
 * 既存の条件から型を推す（移行と、型が空の条件の既定）。004_amend.sql の A-071 と同じ規則。
 *   1. イベント式（statement_timing=event）か、紙出版・OEM の許諾 → 回数無制限
 *   2. 時限式（statement_timing=periodic）か、定期の予定明細がある → 期間で決まる
 *   3. 予定明細が 2 行以上 → 回数固定（N＝行数）
 *   4. それ以外 → 一回きり
 */
export function deriveSettlementRule(c: {
  kind: string; usageType?: string | null; statementTiming?: string | null;
  cycle?: string | null; scheduleCount: number; periodicScheduleCount: number;
}): SettlementRule {
  const license = c.kind === "license" || c.kind === "product";
  if (c.statementTiming === "event" || (license && (c.usageType === "pub_print" || c.usageType === "oem"))) {
    return { mode: "open", count: null, cycle: null, graceDays: null };
  }
  if (c.statementTiming === "periodic" || c.periodicScheduleCount > 0) {
    return { mode: "term_bound", count: null, cycle: cycleFromText(c.cycle) ?? (license ? "quarter" : "month"), graceDays: null };
  }
  if (c.scheduleCount >= 2) return { mode: "fixed_count", count: c.scheduleCount, cycle: null, graceDays: null };
  return { mode: "once", count: null, cycle: null, graceDays: null };
}

/** 自由入力だった cycle（「月次」「四半期」「半年」「年1回」）を周期に読む。読めなければ null。 */
export function cycleFromText(text: string | null | undefined): SettlementCycle | null {
  const s = String(text ?? "").trim().toLowerCase();
  if (!s) return null;
  if (/四半期|quarter|3か月|3ヶ月|3カ月/.test(s)) return "quarter";
  if (/半年|半期|6か月|6ヶ月|6カ月|half/.test(s)) return "half_year";
  if (/年|annual|year/.test(s)) return "year";
  if (/月|month/.test(s)) return "month";
  return null;
}

/** 画面に出す 1 行。「回数固定 3 回」「期間で決まる・四半期ごと」。 */
export function settlementRuleLabel(rule: SettlementRule): string {
  if (!rule.mode) return "未設定";
  const base = SETTLEMENT_MODE_LABEL[rule.mode];
  if (rule.mode === "fixed_count") return `${base} ${rule.count ?? "?"} 回`;
  if (rule.mode === "term_bound") return `${base}・${rule.cycle ? SETTLEMENT_CYCLE_LABEL[rule.cycle] : "周期未設定"}`;
  if (rule.mode === "open") return `${base}（終了後 ${rule.graceDays ?? SETTLEMENT_GRACE_DAYS_DEFAULT} 日まで）`;
  return base;
}
