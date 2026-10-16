import type { SettlementCycle } from "./settlement-mode.js";

/**
 * 出版・電子書籍の集計のしかた（年 1 回・年 2 回・年 4 回）。
 *
 * 電子書籍の印税は集計期間を決めて、その期間の売上をまとめて払う。条件明細では
 * 支払条件の文（計算書の回の支払期日と、出版条件書の支払の表が読む）と、決済の型
 * （期間で決まる・周期）の 2 か所に現れる。ここでその 2 つを同じ入力から作り、
 * 文から周期と期間を読み戻す。
 *
 *   年 1 回 … 「毎年7月1日〜翌年6月30日を集計期間とし、10月末日までに支払う。」（従来の既定）
 *   年 2 回 … 「毎年1月1日〜6月30日及び7月1日〜12月31日を集計期間とし、各集計期間の末日の翌々月末日までに支払う。」
 *   年 4 回 … 「毎年1月1日〜3月31日、4月1日〜6月30日、7月1日〜9月30日及び10月1日〜12月31日を集計期間とし、
 *              各集計期間の末日の翌々月末日までに支払う。」
 */
export type DigitalCycle = "year" | "half_year" | "quarter";

export const DIGITAL_CYCLES: Array<{ value: DigitalCycle; label: string; months: number }> = [
  { value: "year", label: "年 1 回", months: 12 },
  { value: "half_year", label: "年 2 回（半年ごと）", months: 6 },
  { value: "quarter", label: "年 4 回（四半期ごと）", months: 3 }
];
export const cycleMonths = (c: DigitalCycle): number => DIGITAL_CYCLES.find((x) => x.value === c)?.months ?? 12;
/** 決済の型の周期（A-071）。年 1 回 = year。 */
export const settlementCycleOf = (c: DigitalCycle): SettlementCycle => c;

export interface DigitalCycleInput {
  cycle: DigitalCycle;
  /** 最初の集計期間が始まる月（1〜12）。年 1 回の既定は 7、年 2 回・年 4 回は 1。 */
  startMonth: number;
  /** 集計期間の末日から何か月後の月末に払うか（1〜6）。年 1 回の既定は 4（6/30 → 10月末日）。 */
  payMonthsAfter: number;
}

export const DIGITAL_CYCLE_DEFAULTS: Record<DigitalCycle, DigitalCycleInput> = {
  year: { cycle: "year", startMonth: 7, payMonthsAfter: 4 },
  half_year: { cycle: "half_year", startMonth: 1, payMonthsAfter: 2 },
  quarter: { cycle: "quarter", startMonth: 1, payMonthsAfter: 2 }
};

const lastDayOf = (month: number) => new Date(Date.UTC(2001, month, 0)).getUTCDate(); // 平年。2 月は 28 日
const wrap = (m: number) => ((m - 1) % 12 + 12) % 12 + 1;
const endDayText = (month: number) => (month === 2 ? "末日" : `${lastDayOf(month)}日`);

/** 集計期間の並び（月）。年 2 回・startMonth 1 → [[1,6],[7,12]]。 */
export function periodsOf(input: DigitalCycleInput): Array<[number, number]> {
  const months = cycleMonths(input.cycle);
  const out: Array<[number, number]> = [];
  for (let i = 0; i < 12 / months; i++) {
    const from = wrap(input.startMonth + i * months);
    out.push([from, wrap(from + months - 1)]);
  }
  return out;
}

const AFTER_TEXT: Record<number, string> = { 1: "翌月", 2: "翌々月" };

/** 支払条件の文を作る。 */
export function digitalPaymentTerms(input: DigitalCycleInput): string {
  const periods = periodsOf(input);
  const range = ([from, to]: [number, number]) =>
    `${from}月1日〜${to < from ? "翌年" : ""}${to}月${endDayText(to)}`;
  const after = Math.min(6, Math.max(1, Math.round(input.payMonthsAfter)));
  if (input.cycle === "year") {
    const payMonth = wrap(periods[0][1] + after);
    return `毎年${range(periods[0])}を集計期間とし、${payMonth}月末日までに支払う。`;
  }
  const list = periods.map(range);
  const joined = list.length === 2 ? `${list[0]}及び${list[1]}` : `${list.slice(0, -1).join("、")}及び${list[list.length - 1]}`;
  const when = AFTER_TEXT[after] ? `${AFTER_TEXT[after]}末日` : `${after}か月後の月の末日`;
  return `毎年${joined}を集計期間とし、各集計期間の末日の${when}までに支払う。`;
}

/** 支払条件の文から集計のしかたを読む。読めなければ null。 */
export function readDigitalCycle(terms: unknown): DigitalCycleInput | null {
  const s = String(terms ?? "").normalize("NFKC").replace(/\s+/g, "").replace(/[~～]/g, "〜");
  const head = /^(?:毎年)?(.+?)を集計期間とし/.exec(s);
  if (!head) return null;
  const ranges = [...head[1].matchAll(/(\d{1,2})月1日〜(?:翌年)?(\d{1,2})月(?:\d{1,2}日|末日)/g)]
    .map((m) => [Number(m[1]), Number(m[2])] as [number, number]);
  if (!ranges.length) return null;
  const cycle: DigitalCycle | null = ranges.length === 1 ? "year" : ranges.length === 2 ? "half_year" : ranges.length === 4 ? "quarter" : null;
  if (!cycle) return null;
  const tail = s.slice(head[0].length);
  let after: number | null = null;
  if (cycle === "year") {
    const m = /(\d{1,2})月末日まで/.exec(tail);
    if (m) after = wrap(Number(m[1]) - ranges[0][1]);
  } else {
    if (/翌々月/.test(tail)) after = 2;
    else if (/翌月/.test(tail)) after = 1;
    else { const m = /(\d)か月後/.exec(tail); if (m) after = Number(m[1]); }
  }
  return { cycle, startMonth: ranges[0][0], payMonthsAfter: after ?? DIGITAL_CYCLE_DEFAULTS[cycle].payMonthsAfter };
}
