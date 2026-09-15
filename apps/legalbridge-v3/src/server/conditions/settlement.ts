/**
 * 条件の進み具合（決着）。
 *
 * 定額の業務委託の条件は、実績 → 検収書 → 支払（割当）と進めば「支払済み」が
 * 事実から導ける。列に「完了」を持たず、事実から出す。手で立てた札は実態と
 * ずれるが、割当の合計は払った額そのもの。
 *
 * ただし V1・V2 の時代に払い終えた条件は V3 に支払の記録が無い。それだけは
 * 人が理由つきで閉じる（closed_at。A-028）。閉じた条件も「完了」として畳む。
 *
 * 料率・単価×数量の条件には「終わり」が無い。実績か支払があれば「進行中」、
 * 期間が過ぎていれば「期間終了」と出すだけで、完了にはしない（閉じれば完了）。
 */

export type SettlementState =
  | "open"            // 未着手
  | "inspected"       // 実績あり・支払なし
  | "payment_planned" // 支払を立てた（未払）
  | "partly_paid"     // 一部支払済み
  | "paid"            // 支払済み（定額に達した）
  | "closed"          // 人が完了扱いにした
  | "in_progress"     // 料率などで実績・支払が動いている
  | "expired";        // 料率などで期間が過ぎた

export const SETTLEMENT_LABEL: Record<SettlementState, string> = {
  open: "未着手", inspected: "検収済み・未払", payment_planned: "支払予定", partly_paid: "一部支払済み",
  paid: "支払済み", closed: "完了扱い", in_progress: "進行中", expired: "期間終了"
};

export interface ConditionSettlement {
  state: SettlementState;
  /** 支払済みか完了扱い。一覧・候補で畳む対象。 */
  done: boolean;
  eventCount: number;
  deliveredAmount: number;
  plannedAmount: number;
  paidAmount: number;
  /** 定額（払い切る額）。無ければ null で、支払済みにはならない。 */
  targetAmount: number | null;
  closedAt: string | null;
  closedReason: string | null;
}

export interface SettlementFacts {
  pricingModel?: string | null;
  flatAmount?: number | null;
  termEnd?: string | null;
  eventCount: number;
  plannedAmount: number;
  paidAmount: number;
  closedAt?: string | null;
}

/** 払い切る額。定額と単価×数量（定額に畳んである）だけが持つ。 */
export function targetAmountOf(f: { pricingModel?: string | null; flatAmount?: number | null }): number | null {
  const model = f.pricingModel ?? "none";
  const flat = Number(f.flatAmount ?? 0);
  return (model === "fixed" || model === "unit_rate") && flat > 0 ? flat : null;
}

export function settlementState(f: SettlementFacts, today = new Date().toISOString().slice(0, 10)): SettlementState {
  if (f.closedAt) return "closed";
  const target = targetAmountOf(f);
  const paid = Number(f.paidAmount ?? 0);
  const planned = Number(f.plannedAmount ?? 0);
  if (target !== null) {
    if (paid >= target) return "paid";
    if (paid > 0) return "partly_paid";
    if (planned > 0) return "payment_planned";
    if (f.eventCount > 0) return "inspected";
    return "open";
  }
  if (paid > 0 || planned > 0 || f.eventCount > 0) return "in_progress";
  if (f.termEnd && f.termEnd < today) return "expired";
  return "open";
}

export const isSettled = (state: SettlementState): boolean => state === "paid" || state === "closed";

/**
 * 一覧の SQL に足す横結合。条件の系列（改訂の全版）をまとめて数える。実績も
 * 割当も旧版の id に付いたまま残るので、今の版だけ見ると改訂した瞬間に未着手へ
 * 戻ってしまう。alias は st。
 */
export const SETTLEMENT_LATERAL_SQL = `
  LEFT JOIN LATERAL (
    WITH series AS (
      SELECT x.id FROM conditions x
       WHERE COALESCE(x.series_id, x.id) = COALESCE(c.series_id, c.id)
    )
    SELECT
      (SELECT count(*)::int FROM condition_events e
        WHERE e.condition_id IN (SELECT id FROM series) AND e.status = 'active') AS event_count,
      (SELECT COALESCE(sum(e.amount), 0)::bigint FROM condition_events e
        WHERE e.condition_id IN (SELECT id FROM series) AND e.status = 'active') AS delivered_amount,
      (SELECT COALESCE(sum(a.amount), 0)::bigint FROM payment_allocations a
         JOIN payments y ON y.id = a.payment_id
        WHERE a.condition_id IN (SELECT id FROM series) AND y.status = 'planned') AS planned_amount,
      (SELECT COALESCE(sum(a.amount), 0)::bigint FROM payment_allocations a
         JOIN payments y ON y.id = a.payment_id
        WHERE a.condition_id IN (SELECT id FROM series) AND y.status = 'paid') AS paid_amount
  ) st ON true`;

export const SETTLEMENT_COLUMNS = `
  st.event_count, st.delivered_amount, st.planned_amount, st.paid_amount,
  c.closed_at, c.closed_reason`;

/** 行（SETTLEMENT_COLUMNS と条件の列）から決着を組む。 */
export function settlementOf(row: Record<string, any>): ConditionSettlement {
  const closedAt = row.closed_at ? new Date(row.closed_at).toISOString() : null;
  const facts: SettlementFacts = {
    pricingModel: row.pricing_model, flatAmount: row.flat_amount === null ? null : Number(row.flat_amount),
    termEnd: row.term_end ? String(row.term_end instanceof Date ? row.term_end.toISOString().slice(0, 10) : row.term_end).slice(0, 10) : null,
    eventCount: Number(row.event_count ?? 0),
    plannedAmount: Number(row.planned_amount ?? 0),
    paidAmount: Number(row.paid_amount ?? 0),
    closedAt
  };
  const state = settlementState(facts);
  return {
    state, done: isSettled(state),
    eventCount: facts.eventCount, deliveredAmount: Number(row.delivered_amount ?? 0),
    plannedAmount: facts.plannedAmount, paidAmount: facts.paidAmount,
    targetAmount: targetAmountOf(facts),
    closedAt, closedReason: row.closed_reason ? String(row.closed_reason) : null
  };
}
