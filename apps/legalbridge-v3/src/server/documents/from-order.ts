import type { Queryable } from "../core/db.js";
import { dateStr, str } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { isSettlementKind } from "./settlement-conditions.js";
import { settlementDocFor, SERVICE_COMPLETION_KEY } from "./settlement-docs.js";

/**
 * 発注書から検収書・役務提供完了通知書を作る。
 *
 * 決済文書に載せる条件は、元の発注書に結んだ条件（document_conditions）だけにする。委託料・実費・手数料は
 * 独立した条件で、委託料から作ると実費の条件が選ばれず、交通費が紙にも支払にも載らなかった。発注書を決定
 * すると、発注書の経費・その他手数料の行も条件になって発注書に結ばれる（settlement-conditions.ts）ので、
 * 発注書から引けば組が揃う。
 *
 * 実費は発注書の額（見込み）をそのまま刷らない。作るときに、実費ごとに
 *   かかった（実額・利用日）／今回はかからなかった／かからなかった（以後も発生しない＝完了扱い）
 * を入れ、かかった分だけを検収書の経費・その他手数料の行にする。発注書に無かった実費も足せる
 * （決定のとき条件になり、実績が立つ）。
 *
 * ここ（buildOrderPlan・draftInputFromOrder）は DB を触らない。読み込みは OrderSettlementService。
 */

export const ORDER_TEMPLATE_KEYS = ["purchase_order", "intl_purchase_order"];

export interface OrderEvent {
  id: number; occurredOn: string | null; amount: number; quantity: number | null; label: string | null;
  /** 決定した決済文書に結んである（= もう選べない）。 */
  documentNo: string | null;
}
export interface OrderLine {
  conditionId: number; conditionNo: string | null; name: string; kind: string; currency: string;
  amount: number | null; timeSettlement: boolean; contractForm: string | null;
  events: OrderEvent[];
  /** 選べる（決済文書に結んでいない）実績がある。 */
  openEvents: number;
  /** 実績がすべて決済済み（もう載せるものが無い）。 */
  settled: boolean;
}
export interface OrderExtra {
  conditionId: number; conditionNo: string | null; kind: "expense" | "fee"; name: string; currency: string;
  /** 発注書の見込みの額（経費は税込）。 */
  plannedAmount: number | null;
  /** 決済済み（決定した決済文書に載った・完了扱い）。 */
  settled: boolean;
  closed: boolean;
}
export interface OrderSettlementPlan {
  order: {
    id: number; documentNo: string | null; title: string | null; templateKey: string; issuedOn: string | null;
    matterId: number | null; agreementId: number | null; counterparty: { id: number; name: string } | null;
  };
  templateKey: string; templateLabel: string;
  lines: OrderLine[];
  extras: OrderExtra[];
  warnings: string[];
}

export interface RawOrderCondition {
  id: number; conditionNo: string | null; name: string; kind: string; currency: string;
  flatAmount: number | null; unitAmount: number | null; quantity: number | null;
  timeSettlement: boolean; contractForm: string | null; closed: boolean; settledOnIssued: boolean;
  events: OrderEvent[];
}

/** 発注書の中身（DB から読んだ条件と実績）から、作る画面に出す組を作る。 */
export function buildOrderPlan(order: OrderSettlementPlan["order"], conditions: RawOrderCondition[]): OrderSettlementPlan {
  const lines: OrderLine[] = [];
  const extras: OrderExtra[] = [];
  for (const c of conditions) {
    if (isSettlementKind(c.kind)) {
      extras.push({
        conditionId: c.id, conditionNo: c.conditionNo, kind: c.kind === "fee" ? "fee" : "expense", name: c.name,
        currency: c.currency, plannedAmount: c.flatAmount,
        settled: c.settledOnIssued || c.events.some((e) => e.documentNo), closed: c.closed
      });
      continue;
    }
    const open = c.events.filter((e) => !e.documentNo).length;
    lines.push({
      conditionId: c.id, conditionNo: c.conditionNo, name: c.name, kind: c.kind, currency: c.currency,
      amount: c.flatAmount ?? (c.unitAmount !== null && c.quantity !== null ? Math.round(c.unitAmount * c.quantity) : null),
      timeSettlement: c.timeSettlement, contractForm: c.contractForm,
      events: c.events, openEvents: open,
      settled: c.events.length > 0 && open === 0
    });
  }
  const intl = order.templateKey === "intl_purchase_order";
  const head = lines.find((l) => !l.settled) ?? lines[0];
  const doc = intl ? { templateKey: "intl_inspection_certificate", label: "検収書（海外）" }
    : settlementDocFor(head ? { kind: head.kind, timeSettlement: head.timeSettlement, contractForm: head.contractForm }
                            : "service");
  const warnings: string[] = [];
  if (!lines.length) warnings.push("この発注書には委託料の条件が結ばれていません。発注書の条件明細を確かめてください");
  if (lines.length && lines.every((l) => l.settled)) warnings.push("この発注書の実績はすべて検収済みです");
  const noEvents = lines.filter((l) => !l.events.length);
  if (noEvents.length) {
    warnings.push(`納品・役務の実績が無い条件があります（${noEvents.map((l) => l.conditionNo ?? l.name).join("・")}）。`
      + "実績が無いと支払が立ちません。条件の画面で実績を記録してから作ってください");
  }
  return { order, templateKey: doc.templateKey, templateLabel: doc.label, lines, extras, warnings };
}

export interface OrderExtraInput {
  /** 発注書の実費・手数料の条件。発注書に無い実費を足すときは null。 */
  conditionId: number | null;
  kind: "expense" | "fee";
  name: string;
  /** incurred＝かかった／skip＝今回はかからなかった／none＝かからなかった（以後も発生しない。完了扱い）。 */
  status: "incurred" | "skip" | "none";
  amount?: number | null;
  spentOn?: string | null;
  remarks?: string | null;
}
export interface OrderDraftInput {
  templateKey?: string | null;
  /** 載せる委託料の実績。 */
  eventIds: number[];
  extras: OrderExtraInput[];
}

/** 作る画面の入力 → 下書きの中身（DocumentIssueService.createDraft に渡す）。 */
export function draftInputFromOrder(plan: OrderSettlementPlan, input: OrderDraftInput): {
  templateKey: string; conditionIds: number[]; matterId: number | null; agreementId: number | null;
  manualInputs: Record<string, unknown>; eventIds: number[];
} {
  const eventToLine = new Map<number, OrderLine>();
  for (const l of plan.lines) for (const e of l.events) eventToLine.set(e.id, l);
  const eventIds = [...new Set(input.eventIds.map(Number))];
  for (const id of eventIds) {
    const line = eventToLine.get(id);
    if (!line) throw new DomainError("VALIDATION", `実績 ${id} はこの発注書の条件のものではありません`);
    if (line.events.find((e) => e.id === id)?.documentNo) {
      throw new DomainError("VALIDATION", `実績 ${id} はもう決済文書に結んであります`);
    }
  }
  // 委託料は選んだ実績の条件。実績を選ばなければ、まだ実績の残っている条件（無ければ全部）。
  const chosen = eventIds.length
    ? plan.lines.filter((l) => eventIds.some((id) => eventToLine.get(id) === l))
    : plan.lines.filter((l) => !l.settled);
  const mainIds = (chosen.length ? chosen : plan.lines).map((l) => l.conditionId);

  const known = new Map(plan.extras.map((x) => [x.conditionId, x]));
  const expenses: Array<Record<string, unknown>> = [];
  const fees: Array<Record<string, unknown>> = [];
  const extraIds: number[] = [];
  const closeIds: number[] = [];
  for (const x of input.extras) {
    if (x.conditionId !== null && !known.has(x.conditionId)) {
      throw new DomainError("VALIDATION", `実費・手数料の条件 ${x.conditionId} はこの発注書のものではありません`);
    }
    if (x.status === "none" && x.conditionId) closeIds.push(x.conditionId);
    if (x.status !== "incurred") continue;
    const amount = Math.round(Number(x.amount ?? 0));
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new DomainError("VALIDATION", `「${x.name || "実費"}」の実額を入れてください（かからなかったなら「かからなかった」に）`);
    }
    const name = String(x.name ?? "").trim() || (x.kind === "fee" ? "その他手数料" : "経費");
    if (x.conditionId) extraIds.push(x.conditionId);
    if (x.kind === "fee") {
      fees.push({ ...(x.conditionId ? { condition_id: x.conditionId } : {}), fee_name: name, amount, remarks: x.remarks ?? "" });
    } else {
      expenses.push({ ...(x.conditionId ? { condition_id: x.conditionId } : {}), expense_name: name, amount_inc_tax: amount,
                      spent_date: x.spentOn ?? null, remarks: x.remarks ?? "" });
    }
  }
  const templateKey = String(input.templateKey ?? "").trim() || plan.templateKey;
  return {
    templateKey,
    conditionIds: [...new Set([...mainIds, ...extraIds])],
    matterId: plan.order.matterId,
    agreementId: plan.order.agreementId,
    eventIds,
    manualInputs: {
      // 空の配列も渡す：渡さないと、検収書は結んだ条件から経費の行を起こす（見込みの額が刷られる）。
      expenses, other_fees: fees,
      _eventIds: eventIds,
      _fromOrderId: plan.order.id,
      ...(closeIds.length ? { _closeExtrasOnIssue: closeIds } : {})
    }
  };
}

export class OrderSettlementService {
  constructor(private readonly database: Queryable) {}

  /** 決定した発注書を番号・件名・相手先で探す（作る画面の候補）。 */
  async search(q: string): Promise<Array<{ id: number; documentNo: string | null; title: string | null; counterparty: string | null;
                                           issuedOn: string | null; templateKey: string }>> {
    try {
      const like = `%${q.trim()}%`;
      const r = await this.database.query(
        `SELECT d.id, d.document_no, v.title, v.counterparty, (d.issued_at AT TIME ZONE 'Asia/Tokyo')::date::text AS issued_on,
                t.template_key
           FROM documents d
           JOIN v_document_display v ON v.document_id = d.id
           JOIN document_template_versions tv ON tv.id = d.template_version_id
           JOIN document_templates t ON t.id = tv.template_id
          WHERE d.status = 'issued' AND t.template_key = ANY($1::text[])
            AND ($2 = '%%' OR d.document_no ILIKE $2 OR v.title ILIKE $2 OR v.counterparty ILIKE $2)
          ORDER BY d.issued_at DESC NULLS LAST, d.id DESC LIMIT 30`, [ORDER_TEMPLATE_KEYS, like]);
      return (r.rows as Array<Record<string, any>>).map((x) => ({
        id: Number(x.id), documentNo: str(x.document_no), title: str(x.title), counterparty: str(x.counterparty),
        issuedOn: str(x.issued_on), templateKey: String(x.template_key)
      }));
    } catch (error) { throw translate(error); }
  }

  async plan(orderId: number): Promise<OrderSettlementPlan> {
    try {
      const head = (await this.database.query(
        `SELECT d.id, d.document_no, d.status, d.matter_id, d.agreement_id, v.title, v.counterparty, v.counterparty_id,
                (d.issued_at AT TIME ZONE 'Asia/Tokyo')::date::text AS issued_on, t.template_key
           FROM documents d
           JOIN v_document_display v ON v.document_id = d.id
           LEFT JOIN document_template_versions tv ON tv.id = d.template_version_id
           LEFT JOIN document_templates t ON t.id = tv.template_id
          WHERE d.id = $1`, [orderId])).rows[0] as Record<string, any> | undefined;
      if (!head) throw new DomainError("NOT_FOUND", `文書 ${orderId} が見つかりません`);
      if (!ORDER_TEMPLATE_KEYS.includes(String(head.template_key))) {
        throw new DomainError("VALIDATION", "発注書を選んでください（検収書・役務提供完了通知書は発注書から作ります）");
      }
      if (head.status !== "issued") throw new DomainError("VALIDATION", "決定した発注書から作ってください（下書き・無効の発注書からは作れません）");

      // 発注書に結んだ条件。改訂されていれば今の版（実績は版の系列で引く）。
      const conds = (await this.database.query(
        `WITH RECURSIVE linked AS (
           SELECT dc.condition_id AS start_id, dc.line_no FROM document_conditions dc WHERE dc.document_id = $1
         ), chain AS (
           SELECT l.start_id, c.id, c.superseded_by_id, 0 AS depth FROM linked l JOIN conditions c ON c.id = l.start_id
           UNION ALL
           SELECT ch.start_id, n.id, n.superseded_by_id, ch.depth + 1 FROM chain ch JOIN conditions n ON n.id = ch.superseded_by_id
            WHERE ch.depth < 50
         ), latest AS (
           SELECT DISTINCT ON (start_id) start_id, id FROM chain ORDER BY start_id, depth DESC
         )
         SELECT c.id, c.condition_no, c.name, c.kind, c.currency, c.flat_amount, c.unit_amount, c.quantity,
                c.time_settlement, c.contract_form, c.status, (c.closed_at IS NOT NULL) AS closed,
                array(SELECT ch.id FROM chain ch WHERE ch.start_id = l.start_id) AS lineage,
                EXISTS (SELECT 1 FROM document_conditions dc2
                          JOIN documents d2 ON d2.id = dc2.document_id
                          JOIN document_template_versions tv2 ON tv2.id = d2.template_version_id
                          JOIN document_templates t2 ON t2.id = tv2.template_id
                         WHERE dc2.condition_id IN (SELECT ch.id FROM chain ch WHERE ch.start_id = l.start_id)
                           AND d2.status = 'issued' AND t2.template_key ~ '(inspection|acceptance|delivery|completion)') AS settled_on_issued,
                l.line_no
           FROM linked l JOIN latest la ON la.start_id = l.start_id JOIN conditions c ON c.id = la.id
          WHERE c.status <> 'void'
          ORDER BY l.line_no`, [orderId])).rows as Array<Record<string, any>>;

      const allIds = [...new Set(conds.flatMap((c) => (c.lineage as unknown[]).map(Number)))];
      const events = allIds.length ? (await this.database.query(
        `SELECT e.id, e.condition_id, e.occurred_on::text AS occurred_on, e.amount, e.quantity,
                COALESCE(NULLIF(e.deliverable, ''), s.label, e.period, e.note) AS label,
                CASE WHEN d.status = 'issued' THEN d.document_no END AS document_no
           FROM condition_events e
           LEFT JOIN condition_schedules s ON s.id = e.schedule_id
           LEFT JOIN documents d ON d.id = e.document_id
          WHERE e.condition_id = ANY($1::bigint[]) AND e.status = 'active'
          ORDER BY e.occurred_on, e.id`, [allIds])).rows as Array<Record<string, any>> : [];

      const raw: RawOrderCondition[] = conds.map((c) => {
        const lineage = new Set((c.lineage as unknown[]).map(Number));
        return {
          id: Number(c.id), conditionNo: str(c.condition_no), name: String(c.name ?? ""), kind: String(c.kind ?? ""),
          currency: String(c.currency ?? "JPY"),
          flatAmount: c.flat_amount === null ? null : Number(c.flat_amount),
          unitAmount: c.unit_amount === null ? null : Number(c.unit_amount),
          quantity: c.quantity === null ? null : Number(c.quantity),
          timeSettlement: c.time_settlement === true, contractForm: str(c.contract_form),
          closed: c.closed === true, settledOnIssued: c.settled_on_issued === true,
          events: events.filter((e) => lineage.has(Number(e.condition_id))).map((e) => ({
            id: Number(e.id), occurredOn: dateStr(e.occurred_on), amount: Number(e.amount ?? 0),
            quantity: e.quantity === null ? null : Number(e.quantity), label: str(e.label), documentNo: str(e.document_no)
          }))
        };
      });
      return buildOrderPlan({
        id: Number(head.id), documentNo: str(head.document_no), title: str(head.title), templateKey: String(head.template_key),
        issuedOn: str(head.issued_on), matterId: head.matter_id ? Number(head.matter_id) : null,
        agreementId: head.agreement_id ? Number(head.agreement_id) : null,
        counterparty: head.counterparty_id ? { id: Number(head.counterparty_id), name: String(head.counterparty ?? "") } : null
      }, raw);
    } catch (error) { throw translate(error); }
  }
}

/** 発注書から作る決済文書として選べるひな形。 */
export const ORDER_SETTLEMENT_TEMPLATES = [
  { key: "inspection_certificate", label: "検収書" },
  { key: SERVICE_COMPLETION_KEY, label: "役務提供完了通知書" },
  { key: "intl_inspection_certificate", label: "検収書（海外）" }
];
