import type { SettlementCycle } from "./settlement-mode.js";

/**
 * 出版・電子書籍の集計のしかた（年 1 回・年 2 回・年 4 回）と支払月・支払日。
 *
 * 電子書籍の印税は集計期間を決めて、その期間の売上をまとめて払う。条件明細では
 * 支払条件の文（計算書の回の支払期日と、出版条件書の支払の表が読む）と、決済の型
 * （期間で決まる・周期）の 2 か所に現れる。ここでその 2 つを同じ入力から作り、
 * 文から読み戻す。
 *
 *   年 1 回 … 「毎年7月1日〜翌年6月30日を集計期間とし、10月末日までに支払う。」（従来の既定）
 *   年 2 回 … 「毎年1月1日〜6月30日及び7月1日〜12月31日を集計期間とし、各集計期間の末日の翌々月末日までに支払う。」
 *   年 4 回 … 「毎年1月1日〜3月31日、…及び10月1日〜12月31日を集計期間とし、各集計期間の末日の翌々月末日までに支払う。」
 *
 * 支払月は「最初の集計期間の支払月」で持つ（年 2 回で 1〜6 月分を 8 月に払うなら 8）。
 * 2 つ目以降の期間は同じだけ後ろにずれる（7〜12 月分は翌年 2 月）。
 */
export type DigitalCycle = "year" | "half_year" | "quarter";
/** 支払日。"end" は末日。 */
export type PayDay = "end" | number;

export const DIGITAL_CYCLES: Array<{ value: DigitalCycle; label: string; months: number }> = [
  { value: "year", label: "年 1 回", months: 12 },
  { value: "half_year", label: "年 2 回（半年ごと）", months: 6 },
  { value: "quarter", label: "年 4 回（四半期ごと）", months: 3 }
];
export const PAY_DAYS: PayDay[] = ["end", 10, 15, 20, 25];
export const payDayLabel = (d: PayDay) => (d === "end" ? "末日" : `${d}日`);
export const cycleMonths = (c: DigitalCycle): number => DIGITAL_CYCLES.find((x) => x.value === c)?.months ?? 12;
export const cycleLabel = (c: DigitalCycle): string => DIGITAL_CYCLES.find((x) => x.value === c)?.label ?? c;
/** 決済の型の周期（A-071）。年 1 回 = year。 */
export const settlementCycleOf = (c: DigitalCycle): SettlementCycle => c;

export interface DigitalCycleInput {
  cycle: DigitalCycle;
  /** 最初の集計期間が始まる月（1〜12）。 */
  startMonth: number;
  /** 最初の集計期間の支払月（1〜12）。期間の末日より後の、最初に来るその月。 */
  payMonth: number;
  /** 支払日。既定は末日。 */
  payDay?: PayDay;
}

export const DIGITAL_CYCLE_DEFAULTS: Record<DigitalCycle, Required<DigitalCycleInput>> = {
  year: { cycle: "year", startMonth: 7, payMonth: 10, payDay: "end" },
  half_year: { cycle: "half_year", startMonth: 1, payMonth: 8, payDay: "end" },
  quarter: { cycle: "quarter", startMonth: 1, payMonth: 5, payDay: "end" }
};

const lastDayOf = (month: number) => new Date(Date.UTC(2001, month, 0)).getUTCDate(); // 平年。2 月は 28 日
export const wrapMonth = (m: number) => ((m - 1) % 12 + 12) % 12 + 1;
const endDayText = (month: number) => (month === 2 ? "末日" : `${lastDayOf(month)}日`);

/** 集計期間の並び（月）。年 2 回・startMonth 1 → [[1,6],[7,12]]。 */
export function periodsOf(input: Pick<DigitalCycleInput, "cycle" | "startMonth">): Array<[number, number]> {
  const months = cycleMonths(input.cycle);
  const out: Array<[number, number]> = [];
  for (let i = 0; i < 12 / months; i++) {
    const from = wrapMonth(input.startMonth + i * months);
    out.push([from, wrapMonth(from + months - 1)]);
  }
  return out;
}

/** 集計期間の末日の月から支払月まで何か月後か（1〜12）。同じ月は 12 か月後ではなく、その月は無し＝翌年の同月と読む。 */
export const monthsAfterEnd = (endMonth: number, payMonth: number) => {
  const d = wrapMonth(payMonth - endMonth);
  return d === 12 ? 12 : d;
};

/** 期間ごとの支払月（表示用）。年 2 回・1 月始まり・支払 8 月 → [[1,6,8],[7,12,2]]。 */
export function payScheduleOf(input: DigitalCycleInput): Array<{ from: number; to: number; payMonth: number; nextYear: boolean }> {
  const periods = periodsOf(input);
  const after = monthsAfterEnd(periods[0][1], input.payMonth);
  return periods.map(([from, to]) => {
    const pay = wrapMonth(to + after);
    return { from, to, payMonth: pay, nextYear: to + after > 12 || to < from };
  });
}

/** 「1〜6 月分は 8 月末日、7〜12 月分は翌年 2 月末日」。 */
export function payScheduleText(input: DigitalCycleInput): string {
  const day = payDayLabel(input.payDay ?? "end");
  return payScheduleOf(input)
    .map((p) => `${p.from}〜${p.to}月分は${p.nextYear ? "翌年" : ""}${p.payMonth}月${day}`)
    .join("、");
}

const RELATIVE: Record<number, string> = { 1: "翌月", 2: "翌々月" };

/** 支払条件の文を作る。 */
export function digitalPaymentTerms(input: DigitalCycleInput): string {
  const periods = periodsOf(input);
  const range = ([from, to]: [number, number]) =>
    `${from}月1日〜${to < from ? "翌年" : ""}${to}月${endDayText(to)}`;
  const day = payDayLabel(input.payDay ?? "end");
  if (input.cycle === "year") {
    return `毎年${range(periods[0])}を集計期間とし、${wrapMonth(input.payMonth)}月${day}までに支払う。`;
  }
  const after = monthsAfterEnd(periods[0][1], input.payMonth);
  const list = periods.map(range);
  const joined = `${list.slice(0, -1).join("、")}及び${list[list.length - 1]}`;
  const month = RELATIVE[after] ?? `${after}か月後の月の`;
  return `毎年${joined}を集計期間とし、各集計期間の末日の${month}${day}までに支払う。`;
}

/** 支払条件の文から集計のしかたを読む。読めなければ null。 */
export function readDigitalCycle(terms: unknown): Required<DigitalCycleInput> | null {
  const s = String(terms ?? "").normalize("NFKC").replace(/\s+/g, "").replace(/[~～]/g, "〜").replace(/翌翌月/g, "翌々月");
  const head = /^(?:毎年)?(.+?)を集計期間とし/.exec(s);
  if (!head) return null;
  const ranges = [...head[1].matchAll(/(\d{1,2})月1日〜(?:翌年)?(\d{1,2})月(?:\d{1,2}日|末日)/g)]
    .map((m) => [Number(m[1]), Number(m[2])] as [number, number]);
  const cycle: DigitalCycle | null = ranges.length === 1 ? "year" : ranges.length === 2 ? "half_year" : ranges.length === 4 ? "quarter" : null;
  if (!cycle) return null;
  const tail = s.slice(head[0].length);
  const dayOf = (t: string): PayDay => {
    const m = /(末日|(\d{1,2})日)まで/.exec(t);
    return !m || m[1] === "末日" ? "end" : Number(m[2]);
  };
  const endMonth = ranges[0][1];
  if (cycle === "year") {
    const m = /(\d{1,2})月(?:末日|\d{1,2}日)まで/.exec(tail);
    if (!m) return null;
    return { cycle, startMonth: ranges[0][0], payMonth: Number(m[1]), payDay: dayOf(tail) };
  }
  let after: number | null = null;
  const n = /(\d{1,2})[かヶカケ]月後の月/.exec(tail);
  if (n) after = Number(n[1]);
  else if (/翌々月/.test(tail)) after = 2;
  else if (/翌月/.test(tail)) after = 1;
  if (after === null) return null;
  return { cycle, startMonth: ranges[0][0], payMonth: wrapMonth(endMonth + after), payDay: dayOf(tail) };
}

/** CSV の「集計のしかた」表記。 */
export const CYCLE_CSV: Record<DigitalCycle, string> = { year: "年1回", half_year: "年2回", quarter: "年4回" };
export function cycleFromCsv(text: string): DigitalCycle | null {
  const t = text.normalize("NFKC").replace(/\s+/g, "");
  if (/^(年1回|年一回|1回|毎年|年次)$/.test(t)) return "year";
  if (/^(年2回|年二回|2回|半年|半年ごと|半期)$/.test(t)) return "half_year";
  if (/^(年4回|年四回|4回|四半期|四半期ごと)$/.test(t)) return "quarter";
  return null;
}
export function payDayFromCsv(text: string): PayDay | null {
  const t = text.normalize("NFKC").replace(/\s+/g, "");
  if (/^末日?$/.test(t)) return "end";
  const m = /^(\d{1,2})日?$/.exec(t);
  return m && Number(m[1]) >= 1 && Number(m[1]) <= 28 ? Number(m[1]) : null;
}
