import type { Queryable, Transactable } from "../core/db.js";
import { dateStr, str } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { payDateFromTerms } from "../conditions/payment-terms.js";
import { PUB_DIGITAL_PAYMENT_TERMS, PUB_PRINT_PAYMENT_TERMS } from "../conditions/write-service.js";
import type { ScheduleLine, ScheduleRow } from "../conditions/schedule-service.js";

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
  /** 何年ぶん立てるか（1〜5）。 */
  count: number;
}

export interface AnnualCloseTarget {
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

/** 立てる回。既存の回と期間が重なる年は飛ばす。 */
export function annualLines(
  input: { from: string; count: number; paymentTerms: string | null; usageType: AnnualUsage },
  existing: ScheduleRow[]
): ScheduleLine[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.from) || Number.isNaN(new Date(`${input.from}T00:00:00Z`).getTime())) {
    throw new DomainError("VALIDATION", `集計期間の開始が読み取れません：${input.from}`);
  }
  if (!(input.count >= 1 && input.count <= 5)) throw new DomainError("VALIDATION", "年数は 1〜5 で指定してください");
  const fallback = input.usageType === "pub_print" ? PUB_PRINT_PAYMENT_TERMS : PUB_DIGITAL_PAYMENT_TERMS;
  const overlaps = (from: string, to: string) => existing.some((row) => {
    const close = row.dueOn ?? row.serviceTo ?? null;
    const start = row.serviceFrom ?? close;
    if (!close) return false;
    return (start ?? close) <= to && close >= from;
  });
  let seq = existing.reduce((m, l) => Math.max(m, l.seq), 0);
  const out: ScheduleLine[] = [];
  for (let i = 0; i < input.count; i += 1) {
    const from = iso(addMonths(input.from, 12 * i));
    const to = iso(dayBefore(addMonths(input.from, 12 * (i + 1))));
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
        detail: { usageType: input.usageType, from: input.from, count: input.count, attached,
                  conditions: preview.targets.filter((t) => t.adding.length).map((t) => t.conditionId) }
      });
      return { ...preview, written, attached };
    } catch (error) { throw translate(error); }
  }

  private async resolve(client: Queryable, input: AnnualCloseInput) {
    const r = await client.query(
      `SELECT c.id, c.condition_no, c.name, c.payment_terms, w.title AS work_title, p.name AS party_name
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

    const targets: AnnualCloseTarget[] = [];
    for (const row of r.rows as Array<Record<string, any>>) {
      const conditionId = Number(row.id);
      const existing = (await this.deps.schedules.list(conditionId)).lines;
      const adding = annualLines({ from: input.from, count: input.count, paymentTerms: str(row.payment_terms), usageType: input.usageType }, existing);
      const periods = [...existing, ...adding].map((l) => ({ from: dateStr(l.serviceFrom), to: dateStr(l.serviceTo) }))
        .filter((p): p is { from: string; to: string } => Boolean(p.from && p.to));
      const days = strays.get(conditionId) ?? [];
      const attaching = days.filter((d) => periods.some((p) => p.from <= d && d <= p.to)).length;
      targets.push({
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
