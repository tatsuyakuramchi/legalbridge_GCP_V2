import { type Queryable, dateStr, int, str } from "../core/db.js";
import { translate } from "../core/errors.js";
import { periodRow, printedDue, type PeriodRow } from "../closing/service.js";
import {
  SETTLEMENT_CYCLE_MONTHS, SETTLEMENT_GRACE_DAYS_DEFAULT, isSettlementCycle, isSettlementMode,
  settlementRuleLabel, type SettlementCycle, type SettlementMode
} from "../conditions/settlement-mode.js";
import { settlementDocFor } from "../documents/settlement-docs.js";

/**
 * 取引管理：条件明細 × 回 を 1 本の表にして、予定 → 実績 → 決済文書 → 支払 を進める。
 *
 * 支払文書処理（月の表）は「その月に締め日が来る予定明細」だけを出していた。ここは
 * 条件の決済の型（A-071）から「回を立ててよいか・残り何回か」を判定し、
 *   - 到来した未済の回
 *   - 期限切れ（終了後の猶予を過ぎた回数無制限・期間で決まる条件）
 *   - 予定の無い条件の「次の回」（回数無制限は出来事のたびに回るので、行が無くても始められる）
 * を同じ表に出す。読むだけ。書くのは既にある入口（実績・文書・支払）。
 */

export interface DealRule {
  mode: SettlementMode | null;
  count: number | null;
  cycle: SettlementCycle | null;
  graceDays: number | null;
  label: string;
  /** 回数の上限（一回きり=1、回数固定=N、期間で決まる=期間÷周期、無制限=null）。 */
  limit: number | null;
  /** 済んだ回（支払まで立った回）。 */
  done: number;
  /** 立ててある回（予定明細の行数）。 */
  planned: number;
  /** 終了後の猶予を過ぎたか（回数無制限・期間で決まる）。 */
  expired: boolean;
  /** 回を立ててよいか。期限切れ・上限到達なら false。 */
  canOpen: boolean;
  /** 残りの回の数（上限があるとき）。 */
  remaining: number | null;
  /** 猶予の終わり（終了日 + 猶予）。 */
  graceUntil: string | null;
}

export interface DealRow extends PeriodRow {
  direction: "in" | "out";
  work: { id: number; title: string } | null;
  usageType: string | null;
  termStart: string | null;
  termEnd: string | null;
  rule: DealRule;
  /** 「3 / 12」のような回の表示。 */
  roundLabel: string;
  /** 決済文書のひな形。作業テーブルへ渡す。 */
  templateKey: string;
  /** 「今回は無し」にした回（許諾料の台帳の印）。 */
  skipped: boolean;
  /** 行の種類。next＝予定の無い条件の次の回（まだ行が無い）／expired＝期限切れの条件。 */
  rowKind: "round" | "unplanned" | "next" | "expired";
  /** いまこの行で押すもの。 */
  action: DealAction;
}

export type DealAction =
  | "record"          // 実績を入れる（納品・検収／売上・製造）
  | "record_planned"  // 予定どおりに実績を立てる（定期・定額）
  | "issue"           // 決済文書を作る（作業テーブルへ）
  | "pay"             // 支払を立てる
  | "paid"            // 支払済みにする／入金を確認した
  | "wait"            // まだ到来していない
  | "revise"          // 条件を改訂する（期限切れ・上限到達）
  | "schedule"        // 回を型から並べる（期間で決まる型で、まだ回が無い）
  | "done";

export interface DealsScope {
  partyId?: number | null;
  matterId?: number | null;
  workId?: number | null;
  conditionId?: number | null;
  kind?: "service" | "license" | null;
  q?: string | null;
}
export type DealsView = "due" | "late" | "pay" | "all";

export interface DealsSummary {
  due: { count: number; amount: number };
  late: { count: number };
  pay: { count: number; amount: number };
  receive: { count: number };
}

export interface DealsList { rows: DealRow[]; summary: DealsSummary; today: string }

const PRINTED_DUE_SQL = `CASE WHEN jsonb_typeof(d.rendered_values) = 'object' THEN COALESCE(
        d.rendered_values->>'PAYMENT_DATE',
        d.rendered_values->>'paymentDueDate',
        d.rendered_values->>'支払期日',
        d.rendered_values->>'summaryPaymentDate') END`;

/** 条件の輪郭（決済の型つき）。 */
const COND_COLUMNS = `
         c.id AS condition_id, c.condition_no, c.name AS condition_name,
         c.kind, c.pricing_model, c.currency, c.payment_terms, c.direction, c.usage_type,
         c.term_start, c.term_end,
         c.settlement_mode, c.settlement_count, c.settlement_cycle, c.settlement_grace_days,
         c.time_settlement, c.contract_form,
         p.id AS party_id, p.name AS party_name,
         w.id AS work_id, w.title AS work_title,
         m.id AS matter_id, m.title AS matter_title`;
const COND_JOINS = `
    LEFT JOIN parties p ON p.id = c.counterparty_id
    LEFT JOIN works   w ON w.id = c.work_id
    LEFT JOIN LATERAL (
      SELECT mm.id, mm.title FROM matter_links ml
        JOIN matters mm ON mm.id = ml.matter_id
       WHERE ml.target_type = 'condition' AND ml.target_ref = c.id::text
       ORDER BY mm.id DESC LIMIT 1
    ) m ON true`;
const DOC_PAY_JOINS = `
    LEFT JOIN documents d ON d.id = e.document_id AND d.status <> 'void'
    LEFT JOIN LATERAL (
      -- 送付は document_delivery に 1 本化（A-074。郵送・CloudSign の画面・過去分も数える）。
      SELECT dv.sent_at FROM document_delivery(d.id) dv
    ) snd ON true
    LEFT JOIN LATERAL (
      SELECT a.amount, a.payment_id FROM payment_allocations a
        JOIN payments py ON py.id = a.payment_id
       WHERE a.event_id = e.id AND py.status <> 'canceled'
       ORDER BY a.payment_id DESC LIMIT 1
    ) al ON true
    LEFT JOIN payments y ON y.id = al.payment_id`;

/** 予定の回。 */
const ROUND_SELECT = `
  SELECT s.id AS schedule_id, s.seq, s.label, s.planned_amount,
         s.due_on, s.pay_on, s.service_from, s.service_to,
         ${COND_COLUMNS},
         e.id AS event_id, e.occurred_on AS event_on, e.amount AS event_amount,
         d.id AS document_id, d.document_no, d.status AS document_status,
         snd.sent_at AS document_sent_at,
         ${PRINTED_DUE_SQL} AS printed_due_on,
         y.id AS payment_id, y.payment_no, y.status AS payment_status, y.paid_on,
         COALESCE(al.amount, 0) AS allocated_amount,
         EXISTS (SELECT 1 FROM royalty_round_skips k WHERE k.schedule_id = s.id) AS skipped
    FROM condition_schedules s
    JOIN conditions c ON c.id = s.condition_id
    ${COND_JOINS}
    LEFT JOIN LATERAL (
      SELECT ev.id, ev.occurred_on, ev.amount, ev.document_id
        FROM condition_events ev
       WHERE ev.schedule_id = s.id AND ev.status = 'active'
       ORDER BY ev.id LIMIT 1
    ) e ON true
    ${DOC_PAY_JOINS}`;

/** 予定の回に結びついていない実績（回数無制限はこれが普通）。 */
const LOOSE_SELECT = `
  SELECT NULL::bigint AS schedule_id, NULL::int AS seq, NULL::text AS label,
         NULL::bigint AS planned_amount,
         e.occurred_on AS due_on, NULL::date AS pay_on,
         NULL::date AS service_from, NULL::date AS service_to,
         ${COND_COLUMNS},
         e.id AS event_id, e.occurred_on AS event_on, e.amount AS event_amount,
         d.id AS document_id, d.document_no, d.status AS document_status,
         snd.sent_at AS document_sent_at,
         ${PRINTED_DUE_SQL} AS printed_due_on,
         y.id AS payment_id, y.payment_no, y.status AS payment_status, y.paid_on,
         COALESCE(al.amount, 0) AS allocated_amount,
         false AS skipped
    FROM condition_events e
    JOIN conditions c ON c.id = e.condition_id
    ${COND_JOINS}
    ${DOC_PAY_JOINS}
   WHERE e.schedule_id IS NULL AND e.status = 'active'`;

/** 回の無い条件（次の回を出す・期限切れを出すため）。 */
const COND_SELECT = `
  SELECT ${COND_COLUMNS},
         (SELECT count(*) FROM condition_schedules s WHERE s.condition_id = c.id) AS planned_n
    FROM conditions c
    ${COND_JOINS}
   WHERE c.status IN ('active', 'scheduled')`;

export class DealsService {
  constructor(private readonly database: Queryable, private readonly today = () => new Date()) {}

  async list(scope: DealsScope = {}, view: DealsView = "due", limit = 500): Promise<DealsList> {
    try {
      const today = this.today().toISOString().slice(0, 10);
      const args: unknown[] = [];
      const narrow = narrowBy(scope, args);
      const active = " AND c.status IN ('active', 'scheduled')";

      const [rounds, loose, conds] = await Promise.all([
        this.database.query(`${ROUND_SELECT} WHERE true${active}${narrow} ORDER BY s.due_on NULLS LAST, c.id, s.seq`, args),
        this.database.query(`${LOOSE_SELECT}${active}${narrow} ORDER BY e.occurred_on DESC, e.id DESC`, args),
        this.database.query(`${COND_SELECT}${narrow} ORDER BY c.id`, args)
      ]);

      // 条件ごとの決まり（済んだ回・立てた回を数えてから）。
      const roundsByCond = new Map<number, any[]>();
      for (const r of rounds.rows as any[]) {
        const id = Number(r.condition_id);
        if (!roundsByCond.has(id)) roundsByCond.set(id, []);
        roundsByCond.get(id)!.push(r);
      }
      const looseByCond = new Map<number, any[]>();
      for (const r of loose.rows as any[]) {
        const id = Number(r.condition_id);
        if (!looseByCond.has(id)) looseByCond.set(id, []);
        looseByCond.get(id)!.push(r);
      }
      const rules = new Map<number, DealRule>();
      for (const c of conds.rows as any[]) {
        const id = Number(c.condition_id);
        const planned = Number(c.planned_n ?? 0);
        const all = [...(roundsByCond.get(id) ?? []), ...(looseByCond.get(id) ?? [])];
        const done = all.filter((r) => r.payment_id).length;
        rules.set(id, ruleOf(c, { planned, done, today }));
      }

      const out: DealRow[] = [];
      for (const r of rounds.rows as any[]) {
        const rule = rules.get(Number(r.condition_id)); if (!rule) continue;
        out.push(toDeal(r, today, "round", rule, false));
      }
      for (const r of loose.rows as any[]) {
        const rule = rules.get(Number(r.condition_id)); if (!rule) continue;
        out.push(toDeal(r, today, "unplanned", rule, true));
      }
      // 次の回・期限切れ：回数無制限（出来事のたび）と、予定の無い条件。
      for (const c of conds.rows as any[]) {
        const id = Number(c.condition_id);
        const rule = rules.get(id)!;
        const hasOpen = [...(roundsByCond.get(id) ?? []), ...(looseByCond.get(id) ?? [])]
          .some((r) => !r.payment_id);
        if (rule.expired && !hasOpen) { out.push(syntheticRow(c, today, "expired", rule)); continue; }
        if (rule.mode === "open" && rule.canOpen && !hasOpen) { out.push(syntheticRow(c, today, "next", rule)); continue; }
        if (rule.mode !== "open" && rule.planned === 0 && rule.canOpen) out.push(syntheticRow(c, today, "next", rule));
      }

      const rows = out.filter((r) => inView(r, view, today)).slice(0, limit);
      const summary = summarize(out, today);
      return { rows, summary, today };
    } catch (error) { throw translate(error); }
  }
}

function narrowBy(scope: DealsScope, args: unknown[]): string {
  const parts: string[] = [];
  if (scope.partyId) { args.push(scope.partyId); parts.push(`c.counterparty_id = $${args.length}`); }
  if (scope.workId) { args.push(scope.workId); parts.push(`c.work_id = $${args.length}`); }
  if (scope.conditionId) { args.push(scope.conditionId); parts.push(`c.id = $${args.length}`); }
  if (scope.matterId) {
    args.push(scope.matterId);
    parts.push(`EXISTS (SELECT 1 FROM matter_links ml WHERE ml.matter_id = $${args.length}
                  AND ml.target_type = 'condition' AND ml.target_ref = c.id::text)`);
  }
  if (scope.kind === "service") parts.push("c.kind IN ('service', 'expense', 'fee')");
  if (scope.kind === "license") parts.push("c.kind IN ('license', 'product')");
  const q = String(scope.q ?? "").trim();
  if (q) {
    args.push(`%${q}%`);
    parts.push(`(c.name ILIKE $${args.length} OR COALESCE(c.condition_no,'') ILIKE $${args.length}
                 OR COALESCE(p.name,'') ILIKE $${args.length} OR COALESCE(w.title,'') ILIKE $${args.length})`);
  }
  return parts.length ? ` AND ${parts.join(" AND ")}` : "";
}

function addDays(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`);
  return new Date(t + days * 86400000).toISOString().slice(0, 10);
}

/** 条件の決まりと残り。 */
export function ruleOf(c: any, x: { planned: number; done: number; today: string }): DealRule {
  const mode: SettlementMode | null = isSettlementMode(c.settlement_mode) ? c.settlement_mode : null;
  const count = int(c.settlement_count);
  const cycle: SettlementCycle | null = isSettlementCycle(c.settlement_cycle) ? c.settlement_cycle : null;
  const graceDays = int(c.settlement_grace_days);
  const termStart = dateStr(c.term_start), termEnd = dateStr(c.term_end);
  const grace = graceDays ?? SETTLEMENT_GRACE_DAYS_DEFAULT;
  const graceUntil = termEnd && (mode === "open" || mode === "term_bound") ? addDays(termEnd, grace) : null;
  const expired = Boolean(graceUntil && graceUntil < x.today);
  let limit: number | null = null;
  if (mode === "once") limit = 1;
  else if (mode === "fixed_count") limit = count;
  else if (mode === "term_bound" && cycle && termStart && termEnd) {
    const months = (Number(termEnd.slice(0, 4)) - Number(termStart.slice(0, 4))) * 12
      + (Number(termEnd.slice(5, 7)) - Number(termStart.slice(5, 7))) + 1;
    limit = Math.max(1, Math.ceil(months / SETTLEMENT_CYCLE_MONTHS[cycle]));
  }
  const remaining = limit === null ? null : Math.max(0, limit - x.done);
  const canOpen = !expired && (limit === null || x.done < limit);
  return { mode, count, cycle, graceDays, label: settlementRuleLabel({ mode, count, cycle, graceDays }),
           limit, done: x.done, planned: x.planned, expired, canOpen, remaining, graceUntil };
}

function actionOf(r: PeriodRow, rule: DealRule, rowKind: DealRow["rowKind"], today: string, direction: "in" | "out"): DealAction {
  if (rowKind === "expired") return "revise";
  if (rowKind === "next") return !rule.canOpen ? "revise" : rule.mode === "term_bound" && rule.planned === 0 ? "schedule" : "record";
  if (r.step === "event") {
    if (r.closingOn && r.closingOn > today) return "wait";
    return r.pricingModel === "revenue_rate" || rowKind === "unplanned" ? "record"
      : (rule.mode === "term_bound" || r.pricingModel === "fixed" || r.pricingModel === "subscription") ? "record_planned" : "record";
  }
  if (r.step === "document") return "issue";
  if (r.step === "payment") return "pay";
  if (r.paymentId && r.paymentStatus !== "paid") return "paid";
  void direction;
  return "done";
}

function roundLabelOf(r: PeriodRow, rule: DealRule, rowKind: DealRow["rowKind"]): string {
  if (rowKind === "next") return rule.mode === "term_bound" && rule.planned === 0 ? `0 / ${rule.limit ?? "?"}`
    : rule.limit !== null ? `${rule.done + 1} / ${rule.limit}` : `第 ${rule.done + 1} 回（次）`;
  if (rowKind === "expired") return "—";
  if (rowKind === "unplanned") return r.eventOn ? `実績 ${r.eventOn}` : "予定なし";
  const seq = r.seq ?? 0;
  if (rule.limit !== null) return `${seq} / ${rule.limit}`;
  return r.label ?? `第 ${seq} 回`;
}

function toDeal(row: any, today: string, rowKind: DealRow["rowKind"], rule: DealRule, unplanned: boolean): DealRow {
  const base = periodRow(row, today, unplanned);
  const direction: "in" | "out" = row.direction === "in" ? "in" : "out";
  return {
    ...base, direction,
    work: row.work_id ? { id: Number(row.work_id), title: String(row.work_title ?? "") } : null,
    usageType: str(row.usage_type),
    termStart: dateStr(row.term_start), termEnd: dateStr(row.term_end),
    rule, roundLabel: roundLabelOf(base, rule, rowKind),
    templateKey: settlementDocFor(base).templateKey,
    skipped: Boolean(row.skipped),
    rowKind,
    action: actionOf(base, rule, rowKind, today, direction)
  };
}

function syntheticRow(c: any, today: string, rowKind: "next" | "expired", rule: DealRule): DealRow {
  const row = { ...c, schedule_id: null, seq: null, label: null, planned_amount: null, due_on: null, pay_on: null,
                service_from: null, service_to: null, event_id: null, event_on: null, event_amount: null,
                document_id: null, document_no: null, document_status: null, document_sent_at: null,
                printed_due_on: null, payment_id: null, payment_no: null, payment_status: null, paid_on: null,
                allocated_amount: 0, skipped: false };
  const d = toDeal(row, today, rowKind, rule, false);
  d.state = rowKind === "expired" ? "期限切れ" : "次の回";
  d.lateDays = 0;
  return d;
}

function inView(r: DealRow, view: DealsView, today: string): boolean {
  const open = r.step !== "done" || (r.paymentId !== null && r.paymentStatus !== "paid");
  // 到来：締め日が来た回。実績が入っている回は締め日の前でも進められる（決済文書・支払の段）。
  const arrived = r.rowKind === "unplanned" || r.rowKind === "next" || r.step !== "event" || (r.closingOn !== null && r.closingOn <= today);
  if (view === "all") return true;
  if (view === "late") return r.rowKind === "expired" || (open && r.lateDays > 0) || (r.rowKind === "round" && open && r.closingOn !== null && r.closingOn < today && r.step === "event");
  if (view === "pay") return r.action === "pay" || r.action === "paid";
  // due：到来した未済の回と、期限切れ・次の回
  return r.rowKind === "expired" || (open && arrived && !r.skipped);
}

function summarize(rows: DealRow[], today: string): DealsSummary {
  const due = rows.filter((r) => inView(r, "due", today) && r.rowKind !== "expired");
  const late = rows.filter((r) => inView(r, "late", today));
  const pay = rows.filter((r) => r.action === "pay" || r.action === "paid");
  // 向きは in＝取得（当社が払う）／out＝許諾（当社が受け取る）。受取は out。
  const receive = rows.filter((r) => r.direction === "out" && (r.action === "pay" || r.action === "paid"));
  const amt = (xs: DealRow[]) => xs.reduce((a, r) => a + (r.eventAmount ?? r.plannedAmount ?? 0), 0);
  return {
    due: { count: due.length, amount: amt(due) },
    late: { count: late.length },
    pay: { count: pay.length, amount: amt(pay) },
    receive: { count: receive.length }
  };
}

export { printedDue };
