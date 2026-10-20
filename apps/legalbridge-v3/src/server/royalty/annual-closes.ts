import type { Queryable, Transactable } from "../core/db.js";
import { dateStr, str } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { INDIVIDUAL_PAY_DAY, payDateFromTerms } from "../conditions/payment-terms.js";
import { PUB_DIGITAL_PAYMENT_TERMS, PUB_PRINT_PAYMENT_TERMS } from "../conditions/write-service.js";
import type { ScheduleLine, ScheduleRow } from "../conditions/schedule-service.js";
import { cycleMonths, readDigitalCycle, type DigitalCycle } from "../conditions/pub-digital-cycle.js";

/**
 * 出版の許諾条件に、年 1 回の締め（時限式の回）をまとめて立てる（docs/royalty-shares.md §5.4）。
 *
 * 電子書籍の印税は「毎年 7/1〜翌 6/30 を集計し、10 月末に払う」契約がふつう。
 * 支払文書処理（まとめて締める）は予定の回が立っている条件を月ごとに拾うので、
 * 回が無いと取込の実績が浮いたままになる。作品が何十点もあるので、条件 1 本ずつ
 * 画面で立てるのではなく、利用形態（電子・紙）で絞って一括で立てる。
 *
 *   - 回は 役務提供期間＝集計期間（7/1〜6/30）、締め日＝期間の末日、支払期日＝条件の
 *     支払条件（読めなければ出版の既定）から。名前は「2025年7月〜2026年6月」。
 *   - 既に同じ期間に回がある条件は飛ばす（重ねて立てない）。既存の回の後ろに足す。
 *   - 置き方は条件の予定明細の入れ替え（ConditionScheduleService.replace）を通す。
 *     実績の付いた回は触らない（replace が守る）。
 *   - 移行時は、浮いている実績の範囲（例 2025/3〜2026/8）を 1 回にまとめて今回の支払で精算したい。
 *     `to` を指定すると 12 か月ずつではなく from〜to の 1 回だけを立て、`onlyWithStrays` で
 *     浮いた実績のある条件だけに絞る（売上の無い作品に回を増やさない）。
 *   - 回より先に売上を取り込んでいると、実績が回に付かず「予定が無いのに実績がある」に
 *     浮く。立てたあと（既にある回も含めて）、浮いている売上の実績を発生日を集計期間に
 *     含む回に付け直す。試算は付け直す件数だけ数える。
 *
 * 必ず試算（preview）を見てから立てる。試算は何も書かない。
 */

export type AnnualUsage = "pub_digital" | "pub_print";

export interface AnnualCloseInput {
  usageType: AnnualUsage;
  /** 集計期間の開始（YYYY-MM-DD。例 2025-07-01）。 */
  from: string;
  /** 何年ぶん立てるか（1〜5）。`to` があれば使わない。 */
  count: number;
  /**
   * 集計期間の終わり（YYYY-MM-DD）。指定すると 12 か月ずつではなく、from〜to の 1 回だけを立てる
   * （移行時に、浮いている実績を 1 回の支払でまとめて精算するため）。
   */
  to?: string | null;
  /** 回に付いていない売上の実績がある条件だけに立てる（売上の無い作品に回を増やさない）。 */
  onlyWithStrays?: boolean;
}

export interface AnnualCloseTarget {
  /** この条件の集計のしかた（支払条件の文か決済の型から。読めなければ年 1 回）。 */
  cycle: DigitalCycle;
  conditionId: number;
  conditionNo: string | null;
  name: string;
  workTitle: string | null;
  partyName: string | null;
  paymentTerms: string | null;
  /** いまある回の数。 */
  existing: number;
  /** 立てる回。 */
  adding: ScheduleLine[];
  /** 立てない理由（全部の期間に回が既にある等）。 */
  skipped: string | null;
  /** 回に付いていない売上の実績のうち、立てる回か既にある回に付け直せる件数。 */
  attaching: number;
  /** 回に付いていない売上の実績のうち、どの回の期間にも入らない件数（残る）。 */
  unattached: number;
}

export interface AnnualCloseDeps {
  schedules: {
    list(conditionId: number): Promise<{ lines: ScheduleRow[] }>;
    replace(conditionId: number, lines: ScheduleLine[], actor: string): Promise<unknown>;
  };
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addMonths = (day: string, months: number): Date => {
  const d = new Date(`${day}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate()));
};
const dayBefore = (d: Date) => new Date(d.getTime() - 86_400_000);

/** 回の名前。「2025年7月〜2026年6月」（RoyaltyCloses の periodLabel と同じ形）。 */
export function periodLabel(from: string, to: string): string {
  const f = new Date(`${from}T00:00:00Z`), t = new Date(`${to}T00:00:00Z`);
  const fy = f.getUTCFullYear(), fm = f.getUTCMonth() + 1, ty = t.getUTCFullYear(), tm = t.getUTCMonth() + 1;
  if (fy === ty && fm === tm) return `${ty}年${tm}月`;
  return fy === ty ? `${fy}年${fm}〜${tm}月` : `${fy}年${fm}月〜${ty}年${tm}月`;
}

/**
 * 回の対象期間の呼び名。役務提供期間（集計期間）があれば最初の開始〜最後の終わり
 * （「2025年7月〜2026年6月」）、無ければ回の名前が 1 つに揃っていればそれ。
 * 計算書の対象期間は回で決める。実績の月から導くと、売上の無い月が端にある作品だけ短くなる。
 */
export function roundPeriodLabel(rows: Array<{ serviceFrom: string | null; serviceTo: string | null; label: string | null }>): string | null {
  if (!rows.length) return null;
  const froms = rows.map((r) => r.serviceFrom).filter((d): d is string => !!d).sort();
  const tos = rows.map((r) => r.serviceTo).filter((d): d is string => !!d).sort();
  if (froms.length === rows.length && tos.length === rows.length) return periodLabel(froms[0]!, tos.at(-1)!);
  const labels = [...new Set(rows.map((r) => String(r.label ?? "").trim()))];
  return labels.length === 1 && labels[0] ? labels[0] : null;
}

/** 個人への支払日：月の末日なら同じ月の 20 日（payment-terms.ts の forPartyKind と同じ）。 */
const individualPayOn = (payOn: string | null | undefined): string | null => {
  if (!payOn) return payOn ?? null;
  const next = new Date(`${payOn}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.getUTCDate() === 1 ? `${payOn.slice(0, 8)}${String(INDIVIDUAL_PAY_DAY).padStart(2, "0")}` : payOn;
};

const validDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(new Date(`${d}T00:00:00Z`).getTime());

/** 立てる回。既存の回と期間が重なる年は飛ばす。`to` があれば from〜to の 1 回だけ。 */
export function annualLines(
  input: { from: string; count: number; to?: string | null; paymentTerms: string | null; usageType: AnnualUsage;
           /** 集計のしかた。年 2 回なら 6 か月、年 4 回なら 3 か月ずつ、年数 × 回数を立てる。既定は年 1 回。 */
           cycle?: DigitalCycle; cycleStartMonth?: number | null },
  existing: ScheduleRow[]
): ScheduleLine[] {
  if (!validDay(input.from)) throw new DomainError("VALIDATION", `集計期間の開始が読み取れません：${input.from}`);
  if (input.to) {
    if (!validDay(input.to)) throw new DomainError("VALIDATION", `集計期間の終わりが読み取れません：${input.to}`);
    if (input.to < input.from) throw new DomainError("VALIDATION", "集計期間の終わりが開始より前です");
  }
  if (!input.to && !(input.count >= 1 && input.count <= 5)) throw new DomainError("VALIDATION", "年数は 1〜5 で指定してください");
  const fallback = input.usageType === "pub_print" ? PUB_PRINT_PAYMENT_TERMS : PUB_DIGITAL_PAYMENT_TERMS;
  const overlaps = (from: string, to: string) => existing.some((row) => {
    const close = row.dueOn ?? row.serviceTo ?? null;
    const start = row.serviceFrom ?? close;
    if (!close) return false;
    return (start ?? close) <= to && close >= from;
  });
  let seq = existing.reduce((m, l) => Math.max(m, l.seq), 0);
  const out: ScheduleLine[] = [];
  const step = cycleMonths(input.cycle ?? "year");
  // 集計期間の区切りに合わせる。年 2 回（1 月・7 月始まり）の条件に 2025-08-01 を渡されても、
  // 2025-07-01 からの期間で立てる（区切りのずれた回を作らない）。
  const start = (() => {
    if (!input.cycleStartMonth || step === 12 && input.cycleStartMonth === Number(input.from.slice(5, 7))) return input.from;
    const fromMonth = Number(input.from.slice(5, 7));
    const back = ((fromMonth - input.cycleStartMonth) % step + step) % step;
    return iso(addMonths(`${input.from.slice(0, 7)}-01`, -back));
  })();
  const perYear = 12 / step;
  const periods: Array<[string, string]> = input.to
    ? [[input.from, input.to]]
    : Array.from({ length: input.count * perYear }, (_, i) =>
        [iso(addMonths(start, step * i)), iso(dayBefore(addMonths(start, step * (i + 1))))] as [string, string]);
  for (const [from, to] of periods) {
    if (overlaps(from, to)) continue;
    seq += 1;
    out.push({
      seq, label: periodLabel(from, to), triggerKind: "periodic", plannedAmount: 0,
      dueOn: to,
      payOn: payDateFromTerms(to, input.paymentTerms) ?? payDateFromTerms(to, fallback),
      serviceFrom: from, serviceTo: to
    });
  }
  return out;
}

export class AnnualCloseService {
  constructor(private readonly database: Transactable, private readonly deps: AnnualCloseDeps) {}

  async preview(input: AnnualCloseInput): Promise<{ targets: AnnualCloseTarget[]; adding: number; skipped: number; attaching: number }> {
    try { return await this.resolve(this.database, input); }
    catch (error) { throw translate(error); }
  }

  async run(input: AnnualCloseInput, actor: string): Promise<{ targets: AnnualCloseTarget[]; adding: number; skipped: number; attaching: number; written: number; attached: number }> {
    try {
      const preview = await this.resolve(this.database, input);
      let written = 0, attached = 0;
      for (const t of preview.targets) {
        if (t.adding.length) {
          const current = (await this.deps.schedules.list(t.conditionId)).lines.map(asLine);
          await this.deps.schedules.replace(t.conditionId, [...current, ...t.adding], actor);
          written += 1;
        }
        if (!t.attaching) continue;
        // 立てたあとの回（id 付き）に、浮いている売上の実績を付け直す。
        const rounds = (await this.deps.schedules.list(t.conditionId)).lines;
        for (const r of rounds) {
          const from = dateStr(r.serviceFrom), to = dateStr(r.serviceTo);
          if (!from || !to) continue;
          const u = await this.database.query(
            `UPDATE condition_events SET schedule_id = $2
              WHERE condition_id = $1 AND schedule_id IS NULL AND status = 'active' AND event_type = 'sales'
                AND occurred_on BETWEEN $3 AND $4`,
            [t.conditionId, r.id, from, to]);
          attached += u.rowCount ?? 0;
        }
      }
      await recordAudit(this.database, {
        actor, action: "royalty.annual_closes", targetType: "import", targetId: 0,
        detail: { usageType: input.usageType, from: input.from, to: input.to ?? null, count: input.count,
                  onlyWithStrays: Boolean(input.onlyWithStrays), attached,
                  conditions: preview.targets.filter((t) => t.adding.length).map((t) => t.conditionId) }
      });
      return { ...preview, written, attached };
    } catch (error) { throw translate(error); }
  }

  private async resolve(client: Queryable, input: AnnualCloseInput) {
    const r = await client.query(
      `SELECT c.id, c.condition_no, c.name, c.payment_terms, c.settlement_cycle, w.title AS work_title, p.name AS party_name
         FROM conditions c
         LEFT JOIN works w ON w.id = c.work_id
         LEFT JOIN parties p ON p.id = c.counterparty_id
        WHERE c.direction = 'in' AND c.kind = 'license' AND c.status = 'active'
          AND c.pricing_model = 'revenue_rate' AND c.usage_type = $1
        ORDER BY w.title NULLS LAST, c.id`, [input.usageType]);
    // 回に付いていない売上の実績（回より先に取り込んだもの）。発生日で回に振り分ける。
    const ids = (r.rows as Array<Record<string, any>>).map((row) => Number(row.id));
    const strayRows = ids.length ? (await client.query(
      `SELECT condition_id, occurred_on FROM condition_events
        WHERE condition_id = ANY($1::bigint[]) AND schedule_id IS NULL AND status = 'active' AND event_type = 'sales'`,
      [ids])).rows as Array<Record<string, any>> : [];
    const strays = new Map<number, string[]>();
    for (const e of strayRows) {
      const day = dateStr(e.occurred_on);
      if (day) strays.set(Number(e.condition_id), [...(strays.get(Number(e.condition_id)) ?? []), day]);
    }
    // 相手先が個人の条件。個人への支払は 20 日（payment-terms.ts の forPartyKind）なので、立てる回の
    // 支払日（支払条件の末日）を同じ月の 20 日にする。
    const individuals = new Set(ids.length ? ((await client.query(
      `SELECT c.id FROM conditions c JOIN parties p ON p.id = c.counterparty_id
        WHERE c.id = ANY($1::bigint[]) AND p.kind = 'individual'`, [ids])).rows as Array<{ id: number }>).map((x) => Number(x.id)) : []);

    const targets: AnnualCloseTarget[] = [];
    for (const row of r.rows as Array<Record<string, any>>) {
      const conditionId = Number(row.id);
      if (input.onlyWithStrays && !strays.has(conditionId)) continue;
      const existing = (await this.deps.schedules.list(conditionId)).lines;
      // 集計のしかた：支払条件の文から読む（期間の区切りもわかる）。読めなければ決済の型の周期、それも無ければ年 1 回。
      const read = input.usageType === "pub_digital" ? readDigitalCycle(row.payment_terms) : null;
      const sc = String(row.settlement_cycle ?? "");
      const cycle: DigitalCycle = read?.cycle
        ?? (input.usageType === "pub_digital" && (sc === "half_year" || sc === "quarter") ? sc : "year");
      const adding = annualLines({ from: input.from, count: input.count, to: input.to ?? null, paymentTerms: str(row.payment_terms),
                                   usageType: input.usageType, cycle, cycleStartMonth: read?.startMonth ?? null }, existing);
      const periods = [...existing, ...adding].map((l) => ({ from: dateStr(l.serviceFrom), to: dateStr(l.serviceTo) }))
        .filter((p): p is { from: string; to: string } => Boolean(p.from && p.to));
      const days = strays.get(conditionId) ?? [];
      if (individuals.has(conditionId)) for (const l of adding) l.payOn = individualPayOn(l.payOn);
      const attaching = days.filter((d) => periods.some((p) => p.from <= d && d <= p.to)).length;
      targets.push({
        cycle,
        conditionId, conditionNo: str(row.condition_no), name: String(row.name ?? ""),
        workTitle: str(row.work_title), partyName: str(row.party_name), paymentTerms: str(row.payment_terms),
        existing: existing.length, adding,
        skipped: adding.length ? null : "この期間の回はもうあります",
        attaching, unattached: days.length - attaching
      });
    }
    return {
      targets,
      adding: targets.filter((t) => t.adding.length).length,
      skipped: targets.filter((t) => !t.adding.length).length,
      attaching: targets.reduce((n, t) => n + t.attaching, 0)
    };
  }
}

const asLine = (row: ScheduleRow): ScheduleLine => ({
  seq: row.seq, label: row.label, triggerKind: row.triggerKind, plannedAmount: row.plannedAmount,
  dueOn: dateStr(row.dueOn), payOn: dateStr(row.payOn), contractForm: row.contractForm ?? null,
  serviceFrom: dateStr(row.serviceFrom), serviceTo: dateStr(row.serviceTo)
});
