import { addMonths } from "../conditions/renewal.js";

/**
 * 更新履歴。契約（合意）と条件明細で同じ表を出す。
 *
 *   2024-04-01  2025-03-31  Start   締結
 *   2025-04-01  2026-03-31  (1)     自動更新（12か月）
 *   2026-04-01  2027-03-31  (2)     自動更新（12か月）
 *   2027-04-01  2027-09-30  End     解除（2027-09-30）
 *
 * 行は保存しない。開始日・当初の終了日・更新の単位・今日から計算で出す。
 * 保存するのは計算で出ないものだけ（合意による更新・不更新・解除）。
 * 最終行の終了日が「いまの終了日」で、契約チェック・満了通知・期限一覧は
 * この日を見る（当初の終了日を見ると、更新のたびに誰かが書き換えることになる）。
 *
 * ここは純粋な計算。DB は触らない。
 */

export interface TermEvent {
  /** renewed 合意による更新（終了日を決め直した）／declined 不更新／terminated 解除 */
  kind: "renewed" | "declined" | "terminated";
  onDate: string;
  /** renewed のときの新しい終了日。 */
  newEnd?: string | null;
  /** 根拠（補助文書・解除合意の番号など）。 */
  basis?: string | null;
}

export interface TermInput {
  termStart: string | null;
  termEnd: string | null;
  autoRenew: boolean | null;
  /** 更新の単位（月）。空なら当初の期間と同じ長さ（それも出なければ 12）。 */
  renewMonths: number | null;
  /** 不更新を決めた日（列で持つもの）。term_events の declined と同じ意味。 */
  renewStoppedOn?: string | null;
  /** 解除日（列で持つもの）。term_events の terminated と同じ意味。 */
  terminatedOn?: string | null;
  events?: TermEvent[];
  /** 締結の根拠。Start 行に出す。 */
  startBasis?: string | null;
}

export interface TermRow {
  start: string;
  end: string | null;
  /** Start／(1)／(2)…／End。1行だけなら Start／End。 */
  label: string;
  kind: "initial" | "auto" | "renewed" | "terminated";
  basis: string;
}

export interface TermHistory {
  rows: TermRow[];
  /** いまの終了日（最終行の終了日）。期限の定めが無ければ null。 */
  currentEnd: string | null;
  /** 更新した回数（Start を除いた行数）。 */
  renewals: number;
  /** 自動更新が止まっているか（不更新か解除）。 */
  stopped: boolean;
  /** 解除されたか。 */
  terminated: boolean;
}

const MAX_MONTHS = 120;
const MAX_ROWS = 200;

const parse = (value: string | null | undefined): Date | null => {
  const s = String(value ?? "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};
const iso = (d: Date) => d.toISOString().slice(0, 10);
const nextDay = (d: Date) => new Date(d.getTime() + 86400000);

/** 当初の期間の長さ（月）。日付から出ないときは 12。 */
export function initialMonths(start: Date | null, end: Date | null): number {
  if (!start || !end || end.getTime() <= start.getTime()) return 12;
  // 終了日の翌日が開始日の n か月後なら n。そうでなければ月数を丸める。
  const after = nextDay(end);
  const months = (after.getUTCFullYear() - start.getUTCFullYear()) * 12
    + (after.getUTCMonth() - start.getUTCMonth());
  return Math.min(Math.max(months || 12, 1), MAX_MONTHS);
}

export function termHistory(input: TermInput, asOf: string | Date = new Date()): TermHistory {
  const start = parse(input.termStart);
  const end = parse(input.termEnd);
  const today = typeof asOf === "string" ? parse(asOf) ?? new Date() : asOf;
  const events = [...(input.events ?? [])]
    .filter((e) => parse(e.onDate))
    .sort((a, b) => String(a.onDate).localeCompare(String(b.onDate)));

  // 列で持つ不更新・解除も、記録と同じ出来事として扱う。
  const stopped = [parse(input.renewStoppedOn),
    ...events.filter((e) => e.kind === "declined").map((e) => parse(e.onDate))]
    .filter((d): d is Date => d !== null).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
  const termination = [
    input.terminatedOn ? { on: parse(input.terminatedOn)!, basis: "解除" } : null,
    ...events.filter((e) => e.kind === "terminated")
      .map((e) => ({ on: parse(e.onDate)!, basis: e.basis ? `解除合意 ${e.basis}` : "解除" }))
  ].filter((t): t is { on: Date; basis: string } => t !== null && t.on !== null)
    .sort((a, b) => a.on.getTime() - b.on.getTime())[0] ?? null;
  const renewedEvents = events.filter((e) => e.kind === "renewed" && parse(e.newEnd));

  const rows: TermRow[] = [];
  const finish = (): TermHistory => {
    // 解除は最後の行を切る。解除日より前の行はそのまま。
    if (termination && rows.length) {
      const cut = termination.on;
      const kept = rows.filter((r) => parse(r.start)!.getTime() <= cut.getTime());
      const last = kept[kept.length - 1];
      if (last && (last.end === null || parse(last.end)!.getTime() > cut.getTime())) {
        kept[kept.length - 1] = { ...last, end: iso(cut), kind: "terminated",
                                  basis: `${termination.basis}（${iso(cut)}）` };
      }
      rows.splice(0, rows.length, ...kept);
    }
    // 名前を振る。1行だけなら Start／End。
    const n = rows.length;
    rows.forEach((r, i) => {
      r.label = n === 1 ? "Start / End" : i === 0 ? "Start" : i === n - 1 ? "End" : `(${i})`;
    });
    const last = rows[n - 1];
    return {
      rows,
      currentEnd: last ? last.end : null,
      renewals: Math.max(n - 1, 0),
      stopped: Boolean(stopped) || Boolean(termination),
      terminated: Boolean(termination)
    };
  };

  if (!start && !end) return finish();
  const startText = start ? iso(start) : (end ? iso(end) : "");
  rows.push({ start: startText, end: end ? iso(end) : null, label: "", kind: "initial",
              basis: input.startBasis ?? "締結" });
  if (!end) return finish();

  const months = Math.min(Math.max(Math.round(input.renewMonths ?? initialMonths(start, end)), 1), MAX_MONTHS);
  const renewing = input.autoRenew === true;
  let cur = end;

  // 合意による更新は、自動更新の有無に関わらず行になる（覚書で期間を決め直した）。
  // 自動更新は今日（または不更新の日・解除日）に届くまで繰り返す。
  const limit = [today, stopped, termination?.on ?? null]
    .filter((d): d is Date => d !== null)
    .reduce((a, b) => (a.getTime() <= b.getTime() ? a : b));

  while (rows.length < MAX_ROWS) {
    const from = nextDay(cur);
    const renewed = renewedEvents.find((e) => {
      const on = parse(e.onDate)!;
      // 更新の合意は、その期間が始まる日（前の終了日の翌日）までに結ばれる。
      return on.getTime() <= from.getTime() && parse(e.newEnd)!.getTime() > cur.getTime();
    });
    if (renewed) {
      const newEnd = parse(renewed.newEnd)!;
      rows.push({ start: iso(from), end: iso(newEnd), label: "", kind: "renewed",
                  basis: renewed.basis ? `合意更新（${renewed.basis}）` : "合意更新" });
      renewedEvents.splice(renewedEvents.indexOf(renewed), 1);
      cur = newEnd;
      continue;
    }
    if (!renewing) break;
    // 満了日ちょうどはまだ更新していない。翌日から次の期間。
    if (cur.getTime() >= limit.getTime()) break;
    const to = addMonths(cur, months);
    rows.push({ start: iso(from), end: iso(to), label: "", kind: "auto",
                basis: `自動更新（${months % 12 === 0 ? `${months / 12}年` : `${months}か月`}）` });
    cur = to;
  }
  return finish();
}

/** 一覧の 1 文。「2026-04-01〜2027-03-31（更新 2回）」 */
export function termSummary(h: TermHistory, termStart: string | null): string {
  const first = h.rows[0];
  const start = first?.start || termStart || "";
  if (!h.currentEnd) return start ? `${start}〜（期間の定めなし）` : "";
  const tail = h.terminated ? "解除" : h.renewals ? `更新 ${h.renewals}回${h.stopped ? "・以後更新しない" : ""}` : "更新なし";
  return `${start}〜${h.currentEnd}（${tail}）`;
}
