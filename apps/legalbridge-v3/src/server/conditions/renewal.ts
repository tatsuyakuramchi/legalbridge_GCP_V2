/**
 * 許諾期間と自動更新（A-039）。
 *
 * 条件は開始日・終了日と「自動更新するか・単位（月）・止めた日」を持つ。
 * 更新した回数は列に持たない。終了日から基準日までに何回分の期間が過ぎたかを
 * 数えれば出るものを列で持つと、数える人と数えない人が出て食い違うし、毎年
 * 誰かが書き換えることになる。止めたくなった日に「止めた日」を入れれば、
 * そこで数が止まる。
 *
 * 基準日は文書の締結日（下書きは今日）。決定した文書は値を保存するので、
 * あとから回数が増えても、過去に出した条件書の中身は変わらない。
 */

export interface RenewalTerms {
  termStart: string | null;
  termEnd: string | null;
  autoRenew: boolean | null;
  /** 更新の単位（月）。12 = 1年。空は 12。 */
  renewMonths: number | null;
  /** 更新を止めた日。以後は更新しない（その期間は満了まで有効）。 */
  renewStoppedOn: string | null;
}

export interface Renewal {
  /** 更新した回数。自動更新しない・終了日が無いときは 0。 */
  count: number;
  /** いまの期間の満了日（更新後）。終了日が無ければ null。 */
  currentEnd: string | null;
  /** 自動更新が止まっているか（止めた日が基準日までに来ている）。 */
  stopped: boolean;
  /** 自動更新する条件か。 */
  renewing: boolean;
}

const DEFAULT_MONTHS = 12;
/** 更新の単位の上限（移行の CHECK と揃える）。壊れた値で無限に回さない。 */
const MAX_MONTHS = 120;

const parse = (value: string | null | undefined): Date | null => {
  const s = String(value ?? "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};
const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * n か月あと。月末は月末に寄せる（1月31日の1か月後は2月28日）。
 * 満了日は月末であることが多いので、ここを素直に足すと日付がずれていく。
 */
export function addMonths(date: Date, months: number): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const day = date.getUTCDate();
  const lastOfSource = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const lastOfTarget = new Date(Date.UTC(y, m + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m + months, day === lastOfSource ? lastOfTarget : Math.min(day, lastOfTarget)));
}

/**
 * 基準日の時点で何回更新したか、いまの期間はいつまでか。
 *
 * 満了日ちょうどはまだ更新していない（その日まで有効）。翌日から次の期間。
 */
export function renewalOf(terms: RenewalTerms, asOf: string | Date = new Date()): Renewal {
  const end = parse(terms.termEnd);
  const renewing = terms.autoRenew === true;
  if (!end || !renewing) {
    return { count: 0, currentEnd: end ? iso(end) : null, stopped: false, renewing };
  }
  const base = typeof asOf === "string" ? parse(asOf) : asOf;
  const stoppedOn = parse(terms.renewStoppedOn);
  // 止めた日が来ていれば、そこまでの更新だけを数える。
  const until = base && stoppedOn ? new Date(Math.min(base.getTime(), stoppedOn.getTime()))
    : (stoppedOn ?? base);
  if (!until) return { count: 0, currentEnd: iso(end), stopped: Boolean(stoppedOn), renewing };

  const months = Math.min(Math.max(Math.round(terms.renewMonths ?? DEFAULT_MONTHS), 1), MAX_MONTHS);
  let cur = end;
  let count = 0;
  while (cur.getTime() < until.getTime()) {
    cur = addMonths(cur, months);
    count += 1;
  }
  return {
    count, currentEnd: iso(cur), renewing,
    stopped: Boolean(stoppedOn && base && stoppedOn.getTime() <= base.getTime())
  };
}

/** 日付を一覧の行に出す形に。「2026.10.1」。 */
export const shortDate = (value: string | null): string => {
  const d = parse(value);
  return d ? `${d.getUTCFullYear()}.${d.getUTCMonth() + 1}.${d.getUTCDate()}` : "";
};

/**
 * 一覧の行に出す1文。「2026.10.1〜2033.9.30（更新 2回）」。
 * 終了日が無ければ「2027.4.1〜（期間の定めなし）」。開始日も無ければ空。
 */
export function renewalLabel(terms: RenewalTerms, asOf: string | Date = new Date()): string {
  const start = shortDate(terms.termStart);
  const r = renewalOf(terms, asOf);
  if (!r.currentEnd) return start ? `${start}〜（期間の定めなし）` : "";
  const period = `${start}〜${shortDate(r.currentEnd)}`;
  if (!r.renewing) return `${period}（更新なし）`;
  return `${period}（更新 ${r.count}回${r.stopped ? "・以後更新しない" : ""}）`;
}
