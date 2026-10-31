import { settlementDocFor } from "../documents/settlement-docs.js";
import { receiptOf, receiptRuleFor, tokyoDate, type ReceiptRule, type ReceiptState } from "../documents/delivery.js";
import { timingOf } from "../royalty/ledger-service.js";

/**
 * 支払文書（A-074）：回ごとの「起点 → 文書 → 送付 → 受領 → 支払」を 1 つの規則で出す。
 *
 * 1 行 ＝ 1 回（条件 × 算定期間、またはイベント 1 回）。画面ごとに判定が違っていた
 * （回の最初の実績だけ見る／下書きでも済にする／条件単位で見る）のを、ここ 1 か所にする。
 *
 * 起点は 2 つ：
 *   イベント式（active。画面の呼び方。旧「能動」） … 製造・印刷・納品・検収など、自社の記録で回が立つ。記録漏れを防ぐため
 *                     製造予定（production_plans）の行も出す。
 *   時限式（passive。旧「受動」） … 締め（時限）のあと、報告書（売上報告・月次報告）や入金を待つ。
 *                     締めから報告期限（既定 30 日）を過ぎたら督促の対象。
 *
 * 文書が「済」なのは、回の実績が全部、決定した決済文書に載っているときだけ。
 * 送付・受領は document_delivery（監査記録）から。過去分は一括で送付済み扱いにしたもの。
 */

export const REPORT_DUE_DAYS_DEFAULT = 30;

const addDays = (iso: string, n: number): string =>
  new Date(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export interface PdCondition {
  id: number; conditionNo: string | null; name: string;
  kind: string; pricingModel: string | null; usageType: string | null; direction: "in" | "out";
  timeSettlement: boolean; statementTiming: string | null; settlementMode: string | null;
  /** 契約形式（準委任なら決済文書は役務提供完了通知書）。 */
  contractForm?: string | null;
  reportDueDays: number | null;
  party: { id: number; name: string } | null;
  work: { id: number; title: string } | null;
}
export interface PdSchedule {
  id: number; conditionId: number; seq: number; label: string | null;
  dueOn: string | null; payOn: string | null; plannedAmount: number | null; triggerKind: string;
}
export interface PdEvent {
  id: number; conditionId: number; scheduleId: number | null; eventType: string;
  occurredOn: string; amount: number; documentId: number | null;
  reportReceivedOn: string | null; quantity: number | null; period: string | null;
}
export interface PdDocument {
  id: number; documentNo: string | null; status: string; templateKey: string | null;
  issuedOn: string | null; sentAt: string | null; sentVia: string | null;
  receivedAt: string | null; receivedVia: string | null; past: boolean; inbound: boolean;
  needsSignature: boolean;
}
export interface PdDraft { id: number; eventIds: number[] }
export interface PdAllocation {
  eventId: number; paymentId: number; paymentNo: string | null; status: string;
  dueOn: string | null; paidOn: string | null;
}
export interface PdPlan {
  id: number; conditionId: number; plannedOn: string; quantity: number | null; label: string | null;
  source: "manual" | "order"; sourceDocumentNo: string | null;
}

export type Trigger = "active" | "passive";
export type SourceState = "ok" | "plan" | "before" | "waiting" | "late" | "skipped";
export type DocState = "wait" | "make" | "draft" | "done";
export type SendState = "none" | "na" | "unsent" | "partial" | "sent" | "past";
export type PayState = "none" | "nopay" | "unset" | "planned" | "paid";
export type NextAction =
  | "record_event" | "remind_report" | "compose" | "finish_draft" | "send"
  | "remind_receipt" | "record_receipt" | "pay" | "none";

export interface PdDocRef {
  id: number; documentNo: string | null; templateKey: string | null; issuedOn: string | null;
  sentOn: string | null; sentVia: string | null; past: boolean; inbound: boolean;
  receipt: { rule: ReceiptRule; state: ReceiptState; dueOn: string | null; on: string | null; via: string | null };
}

export interface PayDocRow {
  key: string;
  condition: { id: number; conditionNo: string | null; name: string; kind: string; pricingModel: string | null;
               usageType: string | null; direction: "in" | "out"; timeSettlement: boolean };
  party: { id: number; name: string } | null;
  work: { id: number; title: string } | null;
  scheduleId: number | null; planId: number | null; eventIds: number[];
  /** 回の名前（「2026年上期」「初版3刷」など）と期間。 */
  label: string; periodFrom: string | null; closeOn: string | null; payOn: string | null;
  /**
   * 回号（この条件の第 N 回）。時限式は締め（予定明細）の seq、イベント式は製造・納品の日の順。
   * 予定の外の実績・製造予定は null。台帳（royalty/ledger-service.ts の roundNo）と同じ数え方。
   */
  roundNo: number | null;
  trigger: Trigger;
  source: { state: SourceState; label: string; detail: string | null; reportDueOn: string | null };
  amount: number | null;
  templateKey: string; documentLabel: string;
  doc: { state: DocState; partial: boolean; draftId: number | null; documents: PdDocRef[] };
  send: { state: SendState; on: string | null; via: string | null };
  receipt: { state: ReceiptState; dueOn: string | null; on: string | null; via: string | null };
  payment: { state: PayState; paymentIds: number[]; paymentNo: string | null; dueOn: string | null; paidOn: string | null };
  next: NextAction;
  /** 期限を過ぎたもの（報告・受領・支払）。 */
  overdue: boolean;
  /** 全部の文書が過去分。 */
  past: boolean;
  skipped: boolean;
}

export interface BuildInput {
  conditions: PdCondition[]; schedules: PdSchedule[]; events: PdEvent[];
  documents: PdDocument[]; drafts: PdDraft[]; allocations: PdAllocation[]; plans: PdPlan[];
  skips: Array<{ conditionId: number; scheduleId: number }>;
  today: string;
}

const ACTIVE_EVENTS = new Set(["manufacturing", "delivery", "inspection"]);
const ACTIVE_TRIGGERS = new Set(["on_delivery", "on_inspection", "on_execution"]);
const EVENT_NAME: Record<string, string> = {
  manufacturing: "製造", delivery: "納品", inspection: "検収", service_period: "役務完了",
  sales: "売上報告", sublicense_receipt: "入金", adjustment: "調整"
};
const md = (iso: string | null) => (iso ? `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}` : "");

/** 報告（相手の報告書）を待つ条件か。料率・再許諾/OEM・時間精算。 */
export function needsReport(c: Pick<PdCondition, "pricingModel" | "usageType" | "timeSettlement">): boolean {
  return c.pricingModel === "revenue_rate" || c.usageType === "sublicense" || c.usageType === "oem" || c.timeSettlement;
}

function waitingLabel(c: PdCondition, trigger: Trigger, triggerKind: string | null): string {
  if (trigger === "active") {
    if (c.kind === "license" || c.kind === "product") return "製造待ち";
    return triggerKind === "on_inspection" ? "検収待ち" : "納品待ち";
  }
  if (c.usageType === "sublicense" || c.usageType === "oem") return "報告・入金待ち";
  if (c.timeSettlement) return "月次報告待ち";
  if (c.pricingModel === "revenue_rate") return "報告待ち";
  return "実績待ち";
}

function sourceOfEvents(events: PdEvent[]): { label: string; detail: string | null } {
  const sorted = [...events].sort((a, b) => b.occurredOn.localeCompare(a.occurredOn));
  const head = sorted[0];
  const reportOn = sorted.find((e) => e.reportReceivedOn)?.reportReceivedOn ?? null;
  const name = EVENT_NAME[head.eventType] ?? "実績";
  const label = reportOn ? `報告 ${md(reportOn)} 受領` : `${name} ${md(head.occurredOn)}`;
  const qty = events.reduce((a, e) => a + (e.quantity ?? 0), 0);
  const parts = [events.length > 1 ? `実績 ${events.length} 件` : null,
                 head.eventType === "manufacturing" && qty ? `${qty.toLocaleString("ja-JP")} 部` : null,
                 head.period].filter(Boolean);
  return { label, detail: parts.length ? parts.join("・") : null };
}

export function buildPayDocRows(input: BuildInput): PayDocRow[] {
  const { today } = input;
  const skipSet = new Set(input.skips.map((s) => `${s.conditionId}:${s.scheduleId}`));
  const docById = new Map(input.documents.map((d) => [d.id, d]));
  const allocByEvent = new Map<number, PdAllocation[]>();
  for (const a of input.allocations) {
    if (!allocByEvent.has(a.eventId)) allocByEvent.set(a.eventId, []);
    allocByEvent.get(a.eventId)!.push(a);
  }
  const out: PayDocRow[] = [];

  for (const c of input.conditions) {
    const events = input.events.filter((e) => e.conditionId === c.id)
      .sort((a, b) => a.occurredOn.localeCompare(b.occurredOn) || a.id - b.id);
    const timing = timingOf(c.statementTiming, c.usageType, c.settlementMode);
    const used = new Set<number>();
    const add = (x: {
      key: string; scheduleId: number | null; planId: number | null; label: string;
      periodFrom: string | null; closeOn: string | null; payOn: string | null;
      events: PdEvent[]; plannedAmount: number | null; triggerKind: string | null; plan: PdPlan | null;
      roundNo: number | null;
    }) => out.push(buildRow(c, x, { today, docById, allocByEvent, drafts: input.drafts,
                                    skipped: x.scheduleId !== null && skipSet.has(`${c.id}:${x.scheduleId}`) }));

    if (timing === "periodic") {
      const rows = input.schedules.filter((s) => s.conditionId === c.id)
        .sort((a, b) => String(a.dueOn ?? "9999").localeCompare(String(b.dueOn ?? "9999")) || a.seq - b.seq);
      // 締め日の無い回（「いつでも」＝納品・完了の都度）は、回に結び付けずに入れた実績を発生日の早い順に
      // 1 回へ 1 日分ずつ当てる。当てないと「回は未済のまま、実績は別の行」に割れて、同じ仕事が 2 行に見える
      // （一回きりの業務委託で実際に起きた）。回に結び付けた実績（scheduleId）があればそれを優先する。
      const looseDays = [...new Set(events.filter((e) => !e.scheduleId).map((e) => e.occurredOn))].sort();
      rows.forEach((s, i) => {
        const prev = rows[i - 1];
        const from = prev?.dueOn ? addDays(prev.dueOn, 1) : null;
        let mine = events.filter((e) => {
          if (used.has(e.id)) return false;
          if (e.scheduleId) return e.scheduleId === s.id;
          return !!s.dueOn && e.occurredOn <= s.dueOn && (!from || e.occurredOn >= from);
        });
        if (!s.dueOn && !mine.length) {
          const day = looseDays.find((d) => events.some((e) => !used.has(e.id) && !e.scheduleId && e.occurredOn === d));
          if (day) mine = events.filter((e) => !used.has(e.id) && !e.scheduleId && e.occurredOn === day);
        }
        mine.forEach((e) => used.add(e.id));
        add({ key: `s:${s.id}`, scheduleId: s.id, planId: null,
              label: s.label ?? (s.dueOn ? `${s.dueOn.slice(0, 7)} 締め` : `第 ${s.seq} 回`),
              periodFrom: from, closeOn: s.dueOn, payOn: s.payOn, events: mine,
              plannedAmount: s.plannedAmount, triggerKind: s.triggerKind, plan: null, roundNo: s.seq });
      });
    }
    // イベント式の回、または予定の外の実績：発生日ごとに 1 回（同じ日の報告は 1 枚にまとめる）。
    const byDay = new Map<string, PdEvent[]>();
    for (const e of events.filter((x) => !used.has(x.id))) {
      if (!byDay.has(e.occurredOn)) byDay.set(e.occurredOn, []);
      byDay.get(e.occurredOn)!.push(e);
    }
    const days = [...byDay.keys()].sort();
    for (const [day, list] of byDay) {
      add({ key: `e:${c.id}:${day}`, scheduleId: null, planId: null,
            // イベント式なら製造・納品の日の順が回号。時限式の予定の外の実績は数えない。
            roundNo: timing === "event" ? days.indexOf(day) + 1 : null,
            label: list.find((e) => e.period)?.period ?? `${EVENT_NAME[list[0].eventType] ?? "実績"} ${day}`,
            periodFrom: day, closeOn: day, payOn: null, events: list, plannedAmount: null,
            triggerKind: list.every((e) => ACTIVE_EVENTS.has(e.eventType)) || timing === "event" ? "on_delivery" : null,
            plan: null });
    }
    // 製造予定（まだ実績の無いもの）。
    for (const p of input.plans.filter((x) => x.conditionId === c.id)) {
      add({ key: `p:${p.id}`, scheduleId: null, planId: p.id,
            label: p.label ?? `製造予定 ${p.plannedOn}`, periodFrom: p.plannedOn, closeOn: p.plannedOn, payOn: null,
            events: [], plannedAmount: null, triggerKind: "on_delivery", plan: p, roundNo: null });
    }
  }
  return out;
}

function buildRow(c: PdCondition, x: {
  key: string; scheduleId: number | null; planId: number | null; label: string;
  periodFrom: string | null; closeOn: string | null; payOn: string | null;
  events: PdEvent[]; plannedAmount: number | null; triggerKind: string | null; plan: PdPlan | null;
  roundNo: number | null;
}, ctx: {
  today: string; docById: Map<number, PdDocument>; allocByEvent: Map<number, PdAllocation[]>;
  drafts: PdDraft[]; skipped: boolean;
}): PayDocRow {
  const { today } = ctx;
  const timing = timingOf(c.statementTiming, c.usageType, c.settlementMode);
  const trigger: Trigger = x.plan || timing === "event" || (x.triggerKind && ACTIVE_TRIGGERS.has(x.triggerKind))
    || (x.events.length > 0 && x.events.every((e) => ACTIVE_EVENTS.has(e.eventType))) ? "active" : "passive";
  const settlement = settlementDocFor({ kind: c.kind, timeSettlement: c.timeSettlement, contractForm: c.contractForm ?? null });

  // 起点
  let source: PayDocRow["source"];
  if (x.events.length) {
    source = { state: "ok", reportDueOn: null, ...sourceOfEvents(x.events) };
  } else if (ctx.skipped) {
    source = { state: "skipped", label: "今期は無し", detail: null, reportDueOn: null };
  } else if (x.plan) {
    source = { state: "plan", label: `製造予定 ${md(x.plan.plannedOn)}`,
               detail: [x.plan.quantity ? `${x.plan.quantity.toLocaleString("ja-JP")} 部（予定）` : null,
                        x.plan.source === "order" ? `発注書 ${x.plan.sourceDocumentNo ?? ""} から` : null]
                 .filter(Boolean).join("・") || null, reportDueOn: null };
  } else if (x.closeOn && x.closeOn > today) {
    source = { state: "before", label: `締め前（${md(x.closeOn)}）`, detail: null, reportDueOn: null };
  } else {
    const reportDueOn = trigger === "passive" && needsReport(c) && x.closeOn
      ? addDays(x.closeOn, c.reportDueDays ?? REPORT_DUE_DAYS_DEFAULT) : null;
    const late = !!reportDueOn && today > reportDueOn;
    source = { state: late ? "late" : "waiting", label: waitingLabel(c, trigger, x.triggerKind),
               detail: x.closeOn ? `締め ${md(x.closeOn)}${reportDueOn ? `・報告期限 ${md(reportDueOn)}` : ""}` : null,
               reportDueOn };
  }

  // 文書：決定した決済文書だけを数える。全部の実績が載っていれば済。
  const issued = new Map<number, PdDocument>();
  let covered = 0;
  for (const e of x.events) {
    const d = e.documentId ? ctx.docById.get(e.documentId) : undefined;
    if (d && d.status === "issued") { issued.set(d.id, d); covered++; }
  }
  const eventIds = x.events.map((e) => e.id);
  const draft = covered < x.events.length
    ? ctx.drafts.find((d) => d.eventIds.some((id) => eventIds.includes(id))) ?? null : null;
  const docState: DocState = !x.events.length ? "wait" : covered === x.events.length ? "done" : draft ? "draft" : "make";

  const documents: PdDocRef[] = [...issued.values()].map((d) => {
    const sentOn = tokyoDate(d.sentAt);
    const rule = d.inbound ? "none" : receiptRuleFor(d.templateKey, { needsSignature: d.needsSignature });
    return {
      id: d.id, documentNo: d.documentNo, templateKey: d.templateKey, issuedOn: d.issuedOn,
      sentOn, sentVia: d.sentVia, past: d.past, inbound: d.inbound,
      receipt: { rule, ...receiptOf({ rule, sentOn, receivedOn: tokyoDate(d.receivedAt), receivedVia: d.receivedVia, today }) }
    };
  });

  // 送付
  const tracked = documents.filter((d) => !d.inbound);
  let send: PayDocRow["send"] = { state: "none", on: null, via: null };
  if (documents.length && !tracked.length) send = { state: "na", on: null, via: null };
  else if (tracked.length) {
    const sent = tracked.filter((d) => d.sentOn).sort((a, b) => String(b.sentOn).localeCompare(String(a.sentOn)));
    const state: SendState = !sent.length ? "unsent" : sent.length < tracked.length ? "partial"
      : tracked.every((d) => d.past) ? "past" : "sent";
    send = { state, on: sent[0]?.sentOn ?? null, via: sent[0]?.sentVia ?? null };
  }

  // 受領：1 枚でも期限超過なら超過、待ちがあれば待ち。
  let receipt: PayDocRow["receipt"] = { state: "none", dueOn: null, on: null, via: null };
  if (tracked.length) {
    const rs = tracked.map((d) => d.receipt);
    const pick = (s: ReceiptState) => rs.filter((r) => r.state === s);
    const due = (xs: typeof rs) => xs.map((r) => r.dueOn).filter(Boolean).sort()[0] ?? null;
    if (rs.every((r) => r.state === "na")) receipt = { state: "na", dueOn: null, on: null, via: null };
    else if (pick("late").length) receipt = { state: "late", dueOn: due(pick("late")), on: null, via: null };
    else if (pick("await").length) receipt = { state: "await", dueOn: due(pick("await")), on: null, via: null };
    else if (pick("none").length) receipt = { state: "none", dueOn: null, on: null, via: null };
    else {
      const got = rs.filter((r) => r.state === "received").sort((a, b) => String(b.on).localeCompare(String(a.on)))[0];
      receipt = { state: "received", dueOn: null, on: got?.on ?? null, via: got?.via ?? null };
    }
  }

  // 支払
  const amount = x.events.length ? x.events.reduce((a, e) => a + e.amount, 0) : x.plannedAmount;
  const allocs = x.events.flatMap((e) => (ctx.allocByEvent.get(e.id) ?? []).filter((a) => a.status !== "canceled"));
  let payment: PayDocRow["payment"] = { state: "none", paymentIds: [], paymentNo: null, dueOn: null, paidOn: null };
  if (x.events.length) {
    const ids = [...new Set(allocs.map((a) => a.paymentId))];
    const allocated = x.events.every((e) => allocs.some((a) => a.eventId === e.id));
    if (!allocs.length) {
      payment = { ...payment, state: (amount ?? 0) <= 0 && docState === "done" ? "nopay" : "unset" };
    } else {
      const open = allocs.filter((a) => a.status !== "paid");
      payment = {
        state: allocated && !open.length ? "paid" : "planned", paymentIds: ids,
        paymentNo: allocs[0].paymentNo,
        dueOn: open.map((a) => a.dueOn).filter(Boolean).sort()[0] ?? null,
        paidOn: allocs.map((a) => a.paidOn).filter(Boolean).sort().reverse()[0] ?? null
      };
    }
  }

  const overdue = source.state === "late" || receipt.state === "late"
    || (payment.state === "planned" && !!payment.dueOn && payment.dueOn < today);

  let next: NextAction = "none";
  if (source.state === "late") next = "remind_report";
  else if (source.state === "plan" || source.state === "waiting") next = "record_event";
  else if (docState === "make") next = "compose";
  else if (docState === "draft") next = "finish_draft";
  else if (docState === "done") {
    if (send.state === "unsent" || send.state === "partial") next = "send";
    else if (receipt.state === "late") next = "remind_receipt";
    else if (payment.state === "unset") next = "pay";
    else if (receipt.state === "await") next = "record_receipt";
  }

  return {
    key: x.key,
    condition: { id: c.id, conditionNo: c.conditionNo, name: c.name, kind: c.kind, pricingModel: c.pricingModel,
                 usageType: c.usageType, direction: c.direction, timeSettlement: c.timeSettlement },
    party: c.party, work: c.work,
    scheduleId: x.scheduleId, planId: x.planId, eventIds,
    label: x.label, periodFrom: x.periodFrom, closeOn: x.closeOn, payOn: x.payOn, roundNo: x.roundNo,
    trigger, source, amount, templateKey: settlement.templateKey, documentLabel: settlement.label,
    doc: { state: docState, partial: docState !== "done" && covered > 0, draftId: draft?.id ?? null, documents },
    send, receipt, payment, next, overdue,
    past: tracked.length > 0 && tracked.every((d) => d.past),
    skipped: ctx.skipped
  };
}

// ---------------------------------------------------------------------------
// 絞り込みと数
// ---------------------------------------------------------------------------

export type PayDocTile = "wait" | "make" | "draft" | "unsent" | "await" | "overdue" | "nopay";
export const TILE_TEST: Record<PayDocTile, (r: PayDocRow) => boolean> = {
  wait: (r) => r.doc.state === "wait" && ["plan", "waiting", "late"].includes(r.source.state),
  make: (r) => r.doc.state === "make",
  draft: (r) => r.doc.state === "draft",
  unsent: (r) => r.send.state === "unsent" || r.send.state === "partial",
  await: (r) => r.receipt.state === "await",
  overdue: (r) => r.overdue,
  nopay: (r) => r.doc.state === "done" && r.payment.state === "unset" && ["sent", "past", "na"].includes(r.send.state)
};

/** 要対応：次にすることがある回（締め前・今期は無し・過去分は除く）。 */
export const isTodo = (r: PayDocRow) => r.next !== "none" && !r.past;

export function countTiles(rows: PayDocRow[]): Record<PayDocTile, number> {
  const live = rows.filter((r) => !r.past);
  return Object.fromEntries((Object.keys(TILE_TEST) as PayDocTile[])
    .map((k) => [k, live.filter(TILE_TEST[k]).length])) as Record<PayDocTile, number>;
}

/** 並べ順：期限超過 → 次にすることがある → 締めの古い順。 */
export function sortRows(rows: PayDocRow[]): PayDocRow[] {
  const rank = (r: PayDocRow) => (r.overdue ? 0 : r.next !== "none" ? 1 : 2);
  return [...rows].sort((a, b) => rank(a) - rank(b)
    || String(a.closeOn ?? "9999").localeCompare(String(b.closeOn ?? "9999"))
    || a.key.localeCompare(b.key));
}
