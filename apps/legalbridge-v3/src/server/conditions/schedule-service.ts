import { inTransaction, type Transactable } from "../core/db.js";
import { dateStr, int, str } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";

/**
 * 条件の予定明細。
 *
 * 毎月28万円の1年契約は、12行の明細として並ぶ。この表（condition_schedules）
 * は最初からあったが、読む処理も書く処理も1つも無く、移行でしか行が入らな
 * かった。そのため契約を登録しても「いつ・いくら・何回」が画面に出ず、
 * 検収も支払も、どの月の分なのかを人が覚えているしかなかった。
 *
 * 予定と実績は別の表に分ける。予定を書き換えても実績は動かないし、実績が
 * 付いた行は予定を変えさせない。V2 の検収書は1枚のフォームに予定と実績が
 * 混ざっていて、あとから「これは予定か実績か」が読めなくなっていた。
 *
 * 状態は保存しない。実績（condition_events.schedule_id）と支払の割当から
 * 導く。案件のフローと同じ理由で、二重に持つとずれても気づけない。
 */

export type TriggerKind = "on_execution" | "on_delivery" | "on_inspection" | "periodic";

export const TRIGGER_KINDS: Array<{ value: TriggerKind; label: string; hint: string }> = [
  { value: "periodic", label: "定期", hint: "毎月・毎四半期の顧問料や保守料" },
  { value: "on_inspection", label: "検収後", hint: "成果物の検収を起点に払う" },
  { value: "on_delivery", label: "納品後", hint: "納品を起点に払う" },
  { value: "on_execution", label: "契約時", hint: "着手金・契約一時金" }
];

/**
 * 予定の起点から、実績の種別を決める。予定明細を実績に移すときの既定値で、
 * 画面では変えられる（検収後の予定でも、実際には納品で払うことがある）。
 */
export const EVENT_TYPE_BY_TRIGGER: Record<TriggerKind, string> = {
  on_inspection: "inspection",
  on_delivery: "delivery",
  periodic: "service_period",
  on_execution: "service_period"
};

export interface ScheduleLine {
  seq: number;
  label: string | null;
  triggerKind: TriggerKind;
  plannedAmount: number;
  dueOn: string | null;
}

export interface ScheduleRow extends ScheduleLine {
  id: number;
  /** 実績が付いているか。付いていれば予定は書き換えさせない。 */
  eventId: number | null;
  eventOn: string | null;
  eventAmount: number | null;
  /** 支払まで済んでいるか。 */
  paidAmount: number;
  status: "planned" | "recorded" | "paid";
}

export interface ScheduleView {
  conditionId: number;
  currency: string;
  lines: ScheduleRow[];
  total: { planned: number; recorded: number; paid: number };
}

/** 毎月・毎四半期の明細を組み立てる。名前は「2026年4月分」の形にする。 */
export function generateLines(input: {
  startOn: string; count: number; everyMonths: number;
  amount: number; triggerKind: TriggerKind; labelSuffix?: string;
}): ScheduleLine[] {
  const start = new Date(`${input.startOn}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) {
    throw new DomainError("VALIDATION", `開始日が読み取れません：${input.startOn}`);
  }
  if (input.count < 1 || input.count > 120) {
    throw new DomainError("VALIDATION", "回数は 1〜120 の範囲で指定してください");
  }
  const every = Math.max(1, Math.round(input.everyMonths));
  const suffix = input.labelSuffix ?? "分";

  // 開始日がその月の末日なら、以降も末日で揃える。「翌月末払い」の契約で
  // 4/30 開始が 5/30・6/30 になると、毎月ずれた期日が並ぶ。
  const lastOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const startsAtMonthEnd =
    start.getUTCDate() === lastOfMonth(start.getUTCFullYear(), start.getUTCMonth());

  return Array.from({ length: input.count }, (_, i) => {
    const year = start.getUTCFullYear();
    const month = start.getUTCMonth() + i * every;
    const day = startsAtMonthEnd
      ? lastOfMonth(new Date(Date.UTC(year, month, 1)).getUTCFullYear(),
                    new Date(Date.UTC(year, month, 1)).getUTCMonth())
      // 末日でなければ日を保つ。その月に無い日（2/30）はその月の末日へ寄せる。
      : Math.min(start.getUTCDate(),
                 lastOfMonth(new Date(Date.UTC(year, month, 1)).getUTCFullYear(),
                             new Date(Date.UTC(year, month, 1)).getUTCMonth()));
    const d = new Date(Date.UTC(year, month, day));
    const iso = d.toISOString().slice(0, 10);
    return {
      seq: i + 1,
      label: `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${suffix}`,
      triggerKind: input.triggerKind,
      plannedAmount: Math.round(input.amount),
      dueOn: iso
    };
  });
}

export class ConditionScheduleService {
  constructor(private readonly database: Transactable) {}

  async list(conditionId: number): Promise<ScheduleView> {
    try {
      const head = await this.database.query(
        "SELECT id, currency FROM conditions WHERE id = $1", [conditionId]);
      const condition = head.rows[0] as { currency: string } | undefined;
      if (!condition) throw new DomainError("NOT_FOUND", `条件 ${conditionId} が見つかりません`);

      const r = await this.database.query(
        `SELECT s.id, s.seq, s.label, s.trigger_kind, s.planned_amount, s.due_on,
                e.id AS event_id, e.occurred_on AS event_on, e.amount AS event_amount,
                COALESCE((
                  SELECT sum(al.amount) FROM payment_allocations al
                    JOIN payments y ON y.id = al.payment_id
                   WHERE al.event_id = e.id AND y.status = 'paid'
                ), 0) AS paid_amount
           FROM condition_schedules s
           LEFT JOIN LATERAL (
             SELECT id, occurred_on, amount FROM condition_events
              WHERE schedule_id = s.id AND status = 'active'
              ORDER BY id LIMIT 1
           ) e ON true
          WHERE s.condition_id = $1
          ORDER BY s.seq`, [conditionId]);

      const lines: ScheduleRow[] = (r.rows as any[]).map((row) => {
        const paid = Number(row.paid_amount ?? 0);
        const eventId = int(row.event_id);
        return {
          id: Number(row.id),
          seq: Number(row.seq),
          label: str(row.label),
          triggerKind: String(row.trigger_kind) as TriggerKind,
          plannedAmount: Number(row.planned_amount ?? 0),
          dueOn: dateStr(row.due_on),
          eventId,
          eventOn: dateStr(row.event_on),
          eventAmount: int(row.event_amount),
          paidAmount: paid,
          status: paid > 0 ? "paid" : eventId ? "recorded" : "planned"
        };
      });

      return {
        conditionId, currency: String(condition.currency ?? "JPY"), lines,
        total: {
          planned: lines.reduce((s, l) => s + l.plannedAmount, 0),
          recorded: lines.reduce((s, l) => s + (l.eventAmount ?? 0), 0),
          paid: lines.reduce((s, l) => s + l.paidAmount, 0)
        }
      };
    } catch (error) { throw translate(error); }
  }

  /**
   * 明細を置き換える。差分ではなく全体を渡す（支払の割当と同じ形）。
   * 実績が付いている行は消させない。消すと実績の行き先が無くなる。
   */
  async replace(conditionId: number, lines: ScheduleLine[], actor: string) {
    try {
      return await inTransaction(this.database, async (client) => {
        const head = await client.query(
          "SELECT id, status FROM conditions WHERE id = $1", [conditionId]);
        const condition = head.rows[0] as { status: string } | undefined;
        if (!condition) throw new DomainError("NOT_FOUND", `条件 ${conditionId} が見つかりません`);
        if (condition.status === "superseded" || condition.status === "void") {
          throw new DomainError("CONFLICT",
            condition.status === "superseded"
              ? "旧版の明細は変えられません。最新版を開いてください"
              : "無効にした条件の明細は変えられません");
        }

        const seqs = lines.map((l) => l.seq);
        if (new Set(seqs).size !== seqs.length) {
          throw new DomainError("VALIDATION", "明細の番号が重複しています");
        }
        if (lines.some((l) => Math.round(l.plannedAmount) <= 0)) {
          throw new DomainError("VALIDATION", "0円以下の明細は置けません。要らない行は外してください");
        }

        // 実績の付いた行を消そうとしていないか先に確かめる。
        const used = await client.query(
          `SELECT s.id, s.seq, s.label
             FROM condition_schedules s
            WHERE s.condition_id = $1
              AND EXISTS (SELECT 1 FROM condition_events e
                           WHERE e.schedule_id = s.id AND e.status = 'active')`, [conditionId]);
        const keep = new Set((used.rows as any[]).map((x) => Number(x.seq)));
        const missing = [...keep].filter((seq) => !seqs.includes(seq));
        if (missing.length) {
          throw new DomainError("CONFLICT",
            `実績が付いている明細は外せません（${missing.map((s) => `第${s}回`).join("・")}）。` +
            "先に実績を取り消してください");
        }

        await client.query(
          `DELETE FROM condition_schedules
            WHERE condition_id = $1 AND seq <> ALL($2::int[])`,
          [conditionId, seqs.length ? seqs : [0]]);

        for (const line of lines) {
          // ON CONFLICT は使えない。seq の一意制約は移行時の採番のために
          // DEFERRABLE にしてあり、遅延可能な制約は調停に使えないため
          // （PostgreSQL 55000）。更新してみて、無ければ挿す。
          const updated = await client.query(
            `UPDATE condition_schedules
                SET trigger_kind = $3, planned_amount = $4, due_on = $5::date, label = $6
              WHERE condition_id = $1 AND seq = $2`,
            [conditionId, line.seq, line.triggerKind, Math.round(line.plannedAmount),
             line.dueOn, str(line.label)]);
          if ((updated.rowCount ?? 0) === 0) {
            await client.query(
              `INSERT INTO condition_schedules
                 (condition_id, seq, trigger_kind, planned_amount, due_on, label)
               VALUES ($1, $2, $3, $4, $5::date, $6)`,
              [conditionId, line.seq, line.triggerKind, Math.round(line.plannedAmount),
               line.dueOn, str(line.label)]);
          }
        }

        await recordAudit(client, {
          actor, action: "condition.replace_schedules",
          targetType: "condition", targetId: conditionId,
          detail: { lines: lines.length,
                    total: lines.reduce((s, l) => s + Math.round(l.plannedAmount), 0) }
        });
        return { lines: lines.length };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 予定明細を実績に移す。
   *
   * これまで condition_events.schedule_id を書く処理が1つも無く、予定を
   * 立てても「その回が消化されたか」を記録する手段が無かった。予定と実績を
   * 繋ぐのはこの列だけなので、ここが唯一の入口になる。
   *
   * 予定は書き換えない。実績が予定と違う金額でも、予定は予定として残す
   * （いくらの予定がいくらになったかが、あとで読めなくなるため）。
   */
  async record(
    conditionId: number, scheduleId: number,
    input: { occurredOn?: string | null; amount?: number | null;
             eventType?: string | null; note?: string | null },
    actor: string
  ): Promise<{ eventId: number; scheduleId: number }> {
    try {
      return await inTransaction(this.database, async (client) => {
        const head = await client.query(
          "SELECT id, status FROM conditions WHERE id = $1", [conditionId]);
        const condition = head.rows[0] as { status: string } | undefined;
        if (!condition) throw new DomainError("NOT_FOUND", `条件 ${conditionId} が見つかりません`);
        if (condition.status !== "active" && condition.status !== "draft") {
          throw new DomainError("CONFLICT",
            condition.status === "superseded"
              ? "旧版には実績を足せません。最新版を開いてください"
              : condition.status === "scheduled"
              ? "この版はまだ適用前です。実績はいま有効な版に記録してください"
              : "無効にした条件には実績を足せません");
        }

        const found = await client.query(
          `SELECT s.id, s.seq, s.label, s.trigger_kind, s.planned_amount, s.due_on
             FROM condition_schedules s WHERE s.id = $1 AND s.condition_id = $2`,
          [scheduleId, conditionId]);
        const line = found.rows[0] as {
          seq: number; label: string | null; trigger_kind: TriggerKind;
          planned_amount: string | number; due_on: unknown;
        } | undefined;
        if (!line) throw new DomainError("NOT_FOUND", `予定明細 ${scheduleId} が見つかりません`);

        // 1つの予定に実績を二重に付けない。直すなら実績を取り消してからにする。
        const already = await client.query(
          "SELECT id FROM condition_events WHERE schedule_id = $1 AND status = 'active'",
          [scheduleId]);
        if (already.rows[0]) {
          throw new DomainError("CONFLICT",
            `第${line.seq}回にはすでに実績が付いています。` +
            "直すなら先にその実績を取り消してください");
        }

        const amount = Math.round(
          input.amount === null || input.amount === undefined
            ? Number(line.planned_amount ?? 0) : input.amount);
        if (amount <= 0) throw new DomainError("VALIDATION", "実績の金額は1以上です");

        const occurredOn = str(input.occurredOn) ?? dateStr(line.due_on);
        const eventType = str(input.eventType) ?? EVENT_TYPE_BY_TRIGGER[line.trigger_kind];
        // 予定の名前を実績の期間に写す。「2026年4月分」がそのまま計算書に出る。
        const period = str(line.label);

        const inserted = await client.query(
          `INSERT INTO condition_events
             (condition_id, schedule_id, event_type, occurred_on, period,
              gross_amount, deductions, amount, note, created_by)
           VALUES ($1, $2, $3, COALESCE($4::date, current_date), $5, $6, 0, $6, $7, $8)
           RETURNING id`,
          [conditionId, scheduleId, eventType, occurredOn, period, amount,
           str(input.note), actor]);
        const eventId = Number((inserted.rows[0] as { id: number }).id);

        await recordAudit(client, {
          actor, action: "condition.record_schedule",
          targetType: "condition", targetId: conditionId,
          detail: { scheduleId, seq: line.seq, eventId, eventType, amount,
                    plannedAmount: Number(line.planned_amount ?? 0) }
        });
        return { eventId, scheduleId };
      });
    } catch (error) { throw translate(error); }
  }
}
