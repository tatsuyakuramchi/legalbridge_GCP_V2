// サブスク明細の支払予定日（payment_schedule）生成。V1 LineItemTable の
// generatePaymentSchedule の移植。term_start を起点に、周期（月次/四半期/半年/年次/
// カスタムNヶ月・N日）ごとの支払予定日を展開する。月ベースのときは
// billing_day（毎期X日・0/31=月末）と billing_timing（当月/翌月/翌々月）を適用する。
// 発注書テンプレート（国内・海外とも）は明細ごとの payment_schedule 配列を
// そのまま表に印字するため、周期や支払日を変えたらこの配列も作り直す必要がある。

export type PaymentScheduleRow = { date: string; amount?: number };

type ScheduleSource = Record<string, unknown>;

function toISODate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function num(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isDayBasedCycle(item: ScheduleSource): boolean {
  return str(item.cycle) === "CUSTOM" && str(item.interval_unit).toUpperCase() === "DAY";
}

// 次の役務提供期間の起点へ進める。
function stepDate(base: Date, item: ScheduleSource): Date {
  const next = new Date(base);
  if (str(item.cycle) === "CUSTOM") {
    const count = Math.max(1, num(item.interval_count) ?? 1);
    if (str(item.interval_unit).toUpperCase() === "DAY") next.setDate(next.getDate() + count);
    else next.setMonth(next.getMonth() + count);
    return next;
  }
  const cycle = str(item.cycle);
  const months = cycle === "QUARTERLY" ? 3 : cycle === "SEMIANNUAL" ? 6 : cycle === "ANNUAL" ? 12 : 1;
  next.setMonth(next.getMonth() + months);
  return next;
}

// billing_day を適用（0 または 31 以上 = 月末、月の日数を超えるときは月末に丸める）。
function applyBillingDay(date: Date, billingDay: number | undefined): Date {
  if (billingDay === undefined) return date;
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  const day = billingDay === 0 || billingDay > 30 ? lastDay : Math.min(billingDay, lastDay);
  return new Date(date.getFullYear(), date.getMonth(), day);
}

function timingOffsetMonths(timing: unknown): number {
  const value = str(timing).toUpperCase();
  return value === "NEXT_MONTH" ? 1 : value === "MONTH_AFTER_NEXT" ? 2 : 0;
}

/** 周期から支払予定日を生成。term_end があればそこまで、無ければ periods 回分。 */
export function generatePaymentSchedule(item: ScheduleSource, periods: number): PaymentScheduleRow[] {
  const termStart = str(item.term_start);
  if (!termStart) return [];
  const start = new Date(`${termStart}T00:00:00`);
  if (Number.isNaN(start.getTime())) return [];
  const termEnd = str(item.term_end);
  const end = termEnd ? new Date(`${termEnd}T00:00:00`) : null;
  const dayBased = isDayBasedCycle(item);
  const amount = num(item.unit_price) ?? 0;
  const out: PaymentScheduleRow[] = [];
  let cursor = new Date(start);
  const hardCap = 600; // 暴走防止
  for (let i = 0; i < hardCap; i++) {
    // 打ち切りは役務提供期間（cursor）ベース。支払日ベースにすると翌月払いの
    // 最終回（支払だけが term_end より後ろに落ちる）が欠けてしまう。
    if (end && cursor.getTime() > end.getTime()) break;
    let payDate: Date;
    if (dayBased) {
      payDate = cursor;
    } else {
      // 支払月（当月/翌月/翌々月）分だけ月をずらしてから支払日を適用する。
      // 月初1日を基点にして setMonth の月跨ぎ（1/31 + 1ヶ月 → 3/3）を防ぐ。
      const offset = timingOffsetMonths(item.billing_timing);
      const base = offset > 0
        ? new Date(cursor.getFullYear(), cursor.getMonth() + offset, 1)
        : new Date(cursor);
      payDate = applyBillingDay(base, num(item.billing_day));
    }
    out.push({ date: toISODate(payDate), amount });
    if (!end && out.length >= Math.max(1, periods)) break;
    cursor = stepDate(cursor, item);
  }
  return out;
}

/** 保存されている payment_schedule を編集可能な行配列に正規化する。 */
export function normalizePaymentSchedule(value: unknown): PaymentScheduleRow[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((row): row is Record<string, unknown> => !!row && typeof row === "object" && !Array.isArray(row))
    .map((row) => ({ date: str(row.date), amount: num(row.amount) }));
}
