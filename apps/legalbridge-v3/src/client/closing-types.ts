/** 支払文書処理の型。サーバの src/server/closing と対。 */

export interface Due { on: string | null; source: string; label: string }

export interface PeriodRow {
  scheduleId: number | null;
  conditionId: number;
  conditionNo: string | null;
  conditionName: string;
  kind: string;
  pricingModel: string;
  currency: string;
  party: { id: number; name: string } | null;
  matter: { id: number; title: string } | null;
  seq: number | null;
  label: string | null;
  closingOn: string | null;
  serviceFrom: string | null;
  serviceTo: string | null;
  plannedAmount: number | null;
  eventId: number | null;
  eventOn: string | null;
  eventAmount: number | null;
  documentId: number | null;
  documentNo: string | null;
  documentStatus: string | null;
  documentLabel: string;
  paymentId: number | null;
  paymentNo: string | null;
  paymentStatus: string | null;
  paidOn: string | null;
  paidAmount: number;
  step: "event" | "document" | "payment" | "done";
  state: string;
  due: Due;
  monthKey: string | null;
  lateDays: number;
  unplanned: boolean;
}

export interface CandidateRow {
  id: number;
  conditionNo: string | null;
  name: string;
  kind: string;
  pricingModel: string;
  direction: string;
  currency: string;
  needsReport: boolean;
  ratePpm: number | null;
  documentLabel: string;
  party: { id: number; name: string } | null;
  work: { id: number; name: string } | null;
  matter: { id: number; title: string } | null;
  termStart: string | null;
  termEnd: string | null;
  periodCount: number;
  openCount: number;
  nextClosingOn: string | null;
}

export interface PeriodsView {
  condition: CandidateRow;
  rows: PeriodRow[];
  total: { planned: number; recorded: number; paid: number };
}

export interface MonthView {
  month: string; from: string; to: string;
  rows: PeriodRow[];
  counts: Record<PeriodRow["step"], number>;
}

export interface StrayView { overdue: PeriodRow[]; unplanned: PeriodRow[] }

export interface RoyaltyGap {
  id: number; conditionNo: string | null; name: string;
  party: { id: number; name: string } | null;
  work: { id: number; name: string } | null;
  ratePpm: number | null;
  termStart: string | null; termEnd: string | null;
  schedulable: boolean; monthSpan: number | null;
}

export interface ClosePreview {
  targets: Array<{
    scheduleId: number; conditionId: number; conditionName: string;
    seq: number | null; label: string | null; closingOn: string | null;
    party: { id: number; name: string } | null;
    willRecordEvent: boolean; amount: number | null;
    documentLabel: string; dueOn: string | null; dueSource: string; dueLabel: string;
  }>;
  skipped: Array<{ scheduleId: number; conditionName: string; seq: number | null;
                   reason: string; label: string }>;
  documents: Array<{ conditionId: number; conditionName: string; templateKey: string;
                     documentLabel: string; scheduleIds: number[]; issuedOn: string | null;
                     amount: number; willCreatePayment: boolean }>;
  numbers: Array<{ templateKey: string; label: string; prefix: string; year: number;
                   count: number; from: string; to: string }>;
  summary: { rows: number; parties: number; events: number; documents: number;
             payments: number; total: number; dueByLimit: number };
}

export interface CloseResult {
  ok: number; failed: number;
  outcomes: Array<{
    scheduleId: number; conditionId: number; conditionName: string; seq: number | null;
    ok: boolean; eventId: number | null; documentId: number | null; documentNo: string | null;
    paymentId: number | null; paymentNo: string | null;
    reached: "event" | "document" | "payment"; error: string | null;
  }>;
  skipped: ClosePreview["skipped"];
}

/** 月の表示。「2026-08」→「2026年8月分」。 */
export const monthLabel = (month: string): string => {
  const [y, m] = month.split("-");
  return y && m ? `${y}年${Number(m)}月分` : month;
};

/** 月を進める・戻す。 */
export function shiftMonth(month: string, by: number): string {
  const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
  const total = y * 12 + (m - 1) + by;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

export const thisMonth = (): string => new Date().toISOString().slice(0, 7);

/**
 * 段ごとの色。支払期日の「上限60日」だけは別に色を変える（約束の日ではない）。
 */
export const STEP_TONE: Record<PeriodRow["step"], string> = {
  event: "warn", document: "accent", payment: "accent", done: "ok"
};
