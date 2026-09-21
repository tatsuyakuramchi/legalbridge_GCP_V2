import { type Queryable, dateStr, int, str } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import {
  documentFor, dueOf, lateDays, monthKeyOf, monthRange, needsReport, stateLabel, stepOf,
  type Due, type Step
} from "./state.js";

/**
 * 支払文書処理の読み取り。
 *
 * 定期課金も料率（売上報告）も、やることは同じ4手で進む。
 *   予定を立てる → 実績を入れる → 決済文書を出す → 支払を立てる
 * これまではこの4手が、条件画面・実績タブ・文書作成・支払タブに散っていて、
 * 「今月どこまで済んだか」を見る場所が無かった。ここはその1本の表を作る。
 *
 * 書き込みは持たない。実績も文書も支払も、既にそれぞれの入口がある。
 * 同じことを2か所から書けるようにすると、片方の規則だけ通って壊れる。
 */

// ---------------------------------------------------------------------------
// 形
// ---------------------------------------------------------------------------

export interface ClosingScope {
  workId?: number | null;
  partyId?: number | null;
  matterId?: number | null;
  conditionId?: number | null;
  /** 条件名・条件番号・相手先名・作品名のどれかに当たる語。 */
  q?: string | null;
}

export interface CandidateRow {
  id: number;
  conditionNo: string | null;
  name: string;
  kind: string;
  pricingModel: string;
  direction: string;
  currency: string;
  /** 料率は売上報告が来るまで金額が出ない。画面はこれで入力欄を変える。 */
  needsReport: boolean;
  /** その条件の決済文書の呼び名（検収書／計算書）。 */
  documentLabel: string;
  party: { id: number; name: string } | null;
  work: { id: number; name: string } | null;
  matter: { id: number; title: string } | null;
  termStart: string | null;
  termEnd: string | null;
  /** 予定の回の数。0 なら「まだ予定が無い」。 */
  periodCount: number;
  /** 締めの済んでいない回の数。 */
  openCount: number;
  /** 次に締める回の日。無ければ null。 */
  nextClosingOn: string | null;
}

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
  /** 締め日。この日で月を切る。 */
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
  step: Step;
  state: string;
  due: Due;
  monthKey: string | null;
  /** 締め日から何日過ぎているか。まだ締めていない回だけ意味がある。 */
  lateDays: number;
  /** 予定の無い実績（回に結びついていない実績）。 */
  unplanned: boolean;
}

export interface PeriodsView {
  condition: CandidateRow;
  rows: PeriodRow[];
  total: { planned: number; recorded: number; paid: number };
}

export interface StrayView {
  /** 締め日を過ぎたのに実績・報告が入っていない回。月をまたいで溜まる。 */
  overdue: PeriodRow[];
  /** 予定を立てずに実績だけ入った回。締められるが、予定との差が見られない。 */
  unplanned: PeriodRow[];
}

export interface RoyaltyGap {
  id: number;
  conditionNo: string | null;
  name: string;
  party: { id: number; name: string } | null;
  work: { id: number; name: string } | null;
  ratePpm: number | null;
  termStart: string | null;
  termEnd: string | null;
  /** 契約期間が入っていれば画面から並べられる。空なら条件を先に直す。 */
  schedulable: boolean;
  /** 契約期間から出る回数の目安（周期は並べるときに選ぶ）。 */
  monthSpan: number | null;
}

export interface MonthView {
  month: string;
  from: string;
  to: string;
  rows: PeriodRow[];
  /** 段ごとの件数。月の表の頭に出す。 */
  counts: Record<Step, number>;
}

// ---------------------------------------------------------------------------
// 引き
// ---------------------------------------------------------------------------

/**
 * 決済文書に刷られた支払期日。
 *
 * ひな形ごとに鍵の名前が違う（V1・V2 から来たものが混ざっている）ので、
 * 見かける名前を順に見る。日付として読めない値（「翌月末」「令和8年…」）は
 * 期日として使わない。読めない字を日付のふりで並べるより、空のほうがよい。
 */
export const printedDue = (value: unknown): string | null => {
  const s = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

const PRINTED_DUE_SQL = `CASE WHEN jsonb_typeof(d.rendered_values) = 'object' THEN COALESCE(
        d.rendered_values->>'PAYMENT_DATE',
        d.rendered_values->>'paymentDueDate',
        d.rendered_values->>'支払期日',
        d.rendered_values->>'summaryPaymentDate') END`;

/** 条件の輪郭。候補一覧でも、回の一覧の頭でも同じものを出す。 */
const CONDITION_HEAD = `
  SELECT c.id, c.condition_no, c.name, c.kind, c.pricing_model, c.direction, c.currency,
         c.term_start, c.term_end,
         p.id AS party_id, p.name AS party_name,
         w.id AS work_id, w.title AS work_title,
         m.id AS matter_id, m.title AS matter_title,
         (SELECT count(*) FROM condition_schedules s WHERE s.condition_id = c.id) AS period_count
    FROM conditions c
    LEFT JOIN parties p ON p.id = c.counterparty_id
    LEFT JOIN works   w ON w.id = c.work_id
    LEFT JOIN LATERAL (
      SELECT mm.id, mm.title FROM matter_links ml
        JOIN matters mm ON mm.id = ml.matter_id
       WHERE ml.target_type = 'condition' AND ml.target_ref = c.id::text
       ORDER BY mm.id DESC LIMIT 1
    ) m ON true`;

/** 回の1行。予定・実績・決済文書・支払を横に並べる。 */
const PERIOD_SELECT = `
  SELECT s.id AS schedule_id, s.seq, s.label, s.planned_amount,
         s.due_on, s.pay_on, s.service_from, s.service_to,
         c.id AS condition_id, c.condition_no, c.name AS condition_name,
         c.kind, c.pricing_model, c.currency, c.payment_terms,
         p.id AS party_id, p.name AS party_name,
         m.id AS matter_id, m.title AS matter_title,
         e.id AS event_id, e.occurred_on AS event_on, e.amount AS event_amount,
         d.id AS document_id, d.document_no, d.status AS document_status,
         ${PRINTED_DUE_SQL} AS printed_due_on,
         y.id AS payment_id, y.payment_no, y.status AS payment_status, y.paid_on,
         COALESCE(al.amount, 0) AS allocated_amount
    FROM condition_schedules s
    JOIN conditions c ON c.id = s.condition_id
    LEFT JOIN parties p ON p.id = c.counterparty_id
    LEFT JOIN LATERAL (
      SELECT mm.id, mm.title FROM matter_links ml
        JOIN matters mm ON mm.id = ml.matter_id
       WHERE ml.target_type = 'condition' AND ml.target_ref = c.id::text
       ORDER BY mm.id DESC LIMIT 1
    ) m ON true
    LEFT JOIN LATERAL (
      SELECT ev.id, ev.occurred_on, ev.amount, ev.document_id
        FROM condition_events ev
       WHERE ev.schedule_id = s.id AND ev.status = 'active'
       ORDER BY ev.id LIMIT 1
    ) e ON true
    LEFT JOIN documents d ON d.id = e.document_id AND d.status <> 'void'
    LEFT JOIN LATERAL (
      SELECT a.amount, a.payment_id FROM payment_allocations a
        JOIN payments py ON py.id = a.payment_id
       WHERE a.event_id = e.id AND py.status <> 'canceled'
       ORDER BY a.payment_id DESC LIMIT 1
    ) al ON true
    LEFT JOIN payments y ON y.id = al.payment_id`;

/** 予定の回に結びついていない実績。予定を立てずに実績だけ入った分。 */
const UNPLANNED_SELECT = `
  SELECT NULL::bigint AS schedule_id, NULL::int AS seq, NULL::text AS label,
         NULL::bigint AS planned_amount,
         e.occurred_on AS due_on, NULL::date AS pay_on,
         NULL::date AS service_from, NULL::date AS service_to,
         c.id AS condition_id, c.condition_no, c.name AS condition_name,
         c.kind, c.pricing_model, c.currency, c.payment_terms,
         p.id AS party_id, p.name AS party_name,
         m.id AS matter_id, m.title AS matter_title,
         e.id AS event_id, e.occurred_on AS event_on, e.amount AS event_amount,
         d.id AS document_id, d.document_no, d.status AS document_status,
         ${PRINTED_DUE_SQL} AS printed_due_on,
         y.id AS payment_id, y.payment_no, y.status AS payment_status, y.paid_on,
         COALESCE(al.amount, 0) AS allocated_amount
    FROM condition_events e
    JOIN conditions c ON c.id = e.condition_id
    LEFT JOIN parties p ON p.id = c.counterparty_id
    LEFT JOIN LATERAL (
      SELECT mm.id, mm.title FROM matter_links ml
        JOIN matters mm ON mm.id = ml.matter_id
       WHERE ml.target_type = 'condition' AND ml.target_ref = c.id::text
       ORDER BY mm.id DESC LIMIT 1
    ) m ON true
    LEFT JOIN documents d ON d.id = e.document_id AND d.status <> 'void'
    LEFT JOIN LATERAL (
      SELECT a.amount, a.payment_id FROM payment_allocations a
        JOIN payments py ON py.id = a.payment_id
       WHERE a.event_id = e.id AND py.status <> 'canceled'
       ORDER BY a.payment_id DESC LIMIT 1
    ) al ON true
    LEFT JOIN payments y ON y.id = al.payment_id
   WHERE e.schedule_id IS NULL AND e.status = 'active'`;

// ---------------------------------------------------------------------------

export class ClosingService {
  constructor(private readonly database: Queryable, private readonly today = () => new Date()) {}

  /** 条件を探す。作品・取引先・案件・語のどれからでも同じ形で返す。 */
  async candidates(scope: ClosingScope, limit = 100): Promise<CandidateRow[]> {
    try {
      const where: string[] = ["c.status IN ('active', 'scheduled', 'draft')"];
      const args: unknown[] = [];
      // 同じ語を何か所かで使う節があるので、$? は全部を同じ番号に置き換える。
      const add = (sql: string, value: unknown) => {
        args.push(value);
        where.push(sql.replaceAll("$?", `$${args.length}`));
      };

      if (scope.conditionId) add("c.id = $?", scope.conditionId);
      if (scope.workId) add("c.work_id = $?", scope.workId);
      if (scope.partyId) add("c.counterparty_id = $?", scope.partyId);
      if (scope.matterId) {
        add(`EXISTS (SELECT 1 FROM matter_links ml WHERE ml.matter_id = $?
                      AND ml.target_type = 'condition' AND ml.target_ref = c.id::text)`,
          scope.matterId);
      }
      const q = String(scope.q ?? "").trim();
      if (q) {
        add(`(c.name ILIKE '%' || $? || '%' OR c.condition_no ILIKE '%' || $? || '%'
              OR p.name ILIKE '%' || $? || '%' OR w.title ILIKE '%' || $? || '%')`, q);
      }
      if (where.length === 1) {
        throw new DomainError("VALIDATION",
          "探す先を1つ選んでください（作品・取引先・案件・語のどれか）");
      }

      args.push(limit);
      const r = await this.database.query(
        `${CONDITION_HEAD} WHERE ${where.join(" AND ")} ORDER BY c.id DESC LIMIT $${args.length}`,
        args);
      const heads = (r.rows as any[]).map(headRow);
      if (!heads.length) return [];

      // 締めの残りは回の側から数える。条件ごとに副問い合わせを積むより速い。
      const ids = heads.map((h) => h.id);
      const open = await this.database.query(
        `SELECT s.condition_id, count(*) AS open_count, min(s.due_on) AS next_on
           FROM condition_schedules s
          WHERE s.condition_id = ANY($1::bigint[])
            AND NOT EXISTS (
              SELECT 1 FROM condition_events ev
                JOIN payment_allocations a ON a.event_id = ev.id
                JOIN payments py ON py.id = a.payment_id AND py.status <> 'canceled'
               WHERE ev.schedule_id = s.id AND ev.status = 'active')
          GROUP BY s.condition_id`, [ids]);
      const byId = new Map<number, { open: number; next: string | null }>();
      for (const row of open.rows as any[]) {
        byId.set(Number(row.condition_id),
          { open: Number(row.open_count ?? 0), next: dateStr(row.next_on) });
      }
      return heads.map((h) => ({
        ...h,
        openCount: byId.get(h.id)?.open ?? 0,
        nextClosingOn: byId.get(h.id)?.next ?? null
      }));
    } catch (error) { throw translate(error); }
  }

  /** 1つの条件の回を並べる。予定の無い実績も同じ表に混ぜる（見落とさないため）。 */
  async periods(conditionId: number): Promise<PeriodsView> {
    try {
      const head = await this.database.query(
        `${CONDITION_HEAD} WHERE c.id = $1`, [conditionId]);
      const found = (head.rows as any[])[0];
      if (!found) throw new DomainError("NOT_FOUND", `条件 ${conditionId} が見つかりません`);
      const condition: CandidateRow = { ...headRow(found), openCount: 0, nextClosingOn: null };

      const planned = await this.database.query(
        `${PERIOD_SELECT} WHERE s.condition_id = $1 ORDER BY s.seq`, [conditionId]);
      const loose = await this.database.query(
        `${UNPLANNED_SELECT} AND e.condition_id = $1 ORDER BY e.occurred_on, e.id`, [conditionId]);

      const today = this.todayStr();
      const rows = [
        ...(planned.rows as any[]).map((row) => periodRow(row, today, false)),
        ...(loose.rows as any[]).map((row) => periodRow(row, today, true))
      ];
      const open = rows.filter((r) => r.scheduleId !== null && r.step !== "done");
      condition.openCount = open.length;
      condition.nextClosingOn = open.map((r) => r.closingOn).filter((d): d is string => !!d).sort()[0] ?? null;

      return {
        condition, rows,
        total: {
          planned: sum(rows.map((r) => r.plannedAmount ?? 0)),
          recorded: sum(rows.map((r) => r.eventAmount ?? 0)),
          paid: sum(rows.map((r) => r.paidAmount))
        }
      };
    } catch (error) { throw translate(error); }
  }

  /**
   * 月の表。締め日がその月に入る回を全部出す。
   *
   * 済んだ回も出す。「今月これだけ片付いた」が見えないと、残りの意味が分からない。
   * 画面は段で畳む。
   */
  async month(month: string, scope: ClosingScope = {}): Promise<MonthView> {
    try {
      // monthRange は RangeError を投げる。経路から呼ぶので、人に読める
      // 400 に直しておく（そのままだと 500 になる）。
      if (!/^\d{4}-\d{2}$/.test(String(month ?? "").trim())) {
        throw new DomainError("VALIDATION", `月は YYYY-MM で指定してください：${month}`);
      }
      const { from, to } = monthRange(month);
      const args: unknown[] = [from, to];
      const base = narrowBy(scope, args);
      const planned = await this.database.query(
        `${PERIOD_SELECT} WHERE s.due_on >= $1 AND s.due_on < $2${base}
          ORDER BY s.due_on, c.id, s.seq`, args);
      // 予定の無い実績は実績日で月に入れる。締め日が無いので、そこで切るしかない。
      const loose = await this.database.query(
        `${UNPLANNED_SELECT} AND e.occurred_on >= $1 AND e.occurred_on < $2${base}
          ORDER BY e.occurred_on, e.id`, args);

      const today = this.todayStr();
      const rows = [
        ...(planned.rows as any[]).map((row) => periodRow(row, today, false)),
        ...(loose.rows as any[]).map((row) => periodRow(row, today, true))
      ];
      const counts: Record<Step, number> = { event: 0, document: 0, payment: 0, done: 0 };
      for (const row of rows) counts[row.step] += 1;
      return { month, from, to, rows, counts };
    } catch (error) { throw translate(error); }
  }

  /**
   * 月の表からこぼれるもの。
   *
   * 表に並ぶのは「その月に締め日が来る予定明細」だけ。締め日を過ぎたまま
   * 止まっている回は翌月の表に出てこないし、予定を立てずに入れた実績は
   * どの月の表にも出てこない。放っておくと棚卸しで拾うことになる。
   */
  async strays(scope: ClosingScope = {}, limit = 200): Promise<StrayView> {
    try {
      const today = this.todayStr();
      const args: unknown[] = [today];
      const narrow = narrowBy(scope, args);
      args.push(limit);
      const cap = `$${args.length}`;

      const overdue = await this.database.query(
        `${PERIOD_SELECT} WHERE s.due_on < $1 AND e.id IS NULL${narrow}
          ORDER BY s.due_on LIMIT ${cap}`, args);
      const loose = await this.database.query(
        `${UNPLANNED_SELECT} AND e.occurred_on <= $1${narrow}
          ORDER BY e.occurred_on DESC, e.id DESC LIMIT ${cap}`, args);

      return {
        overdue: (overdue.rows as any[]).map((row) => periodRow(row, today, false)),
        unplanned: (loose.rows as any[]).map((row) => periodRow(row, today, true))
      };
    } catch (error) { throw translate(error); }
  }

  /**
   * 料率なのに算定期間が1回も並んでいない条件。
   *
   * 月の表は予定明細を並べたものなので、予定が0本の条件は出てきようがない。
   * 手元の写しでは料率85本のうち84本が並んでいなかった。ここから1本ずつ
   * 拾う。一括では並べない——契約期間の入力が怪しい条件が混ざっていると、
   * 間違った期が84本ぶん並ぶ。
   */
  async royaltyGaps(limit = 200): Promise<RoyaltyGap[]> {
    try {
      const r = await this.database.query(
        `SELECT c.id, c.condition_no, c.name, c.rate_ppm, c.term_start, c.term_end,
                p.id AS party_id, p.name AS party_name,
                w.id AS work_id, w.title AS work_title
           FROM conditions c
           LEFT JOIN parties p ON p.id = c.counterparty_id
           LEFT JOIN works   w ON w.id = c.work_id
          WHERE c.pricing_model = 'revenue_rate'
            AND c.status IN ('active', 'scheduled')
            AND NOT EXISTS (SELECT 1 FROM condition_schedules s WHERE s.condition_id = c.id)
          ORDER BY (c.term_start IS NULL OR c.term_end IS NULL), c.id
          LIMIT $1`, [limit]);
      return (r.rows as any[]).map((row) => {
        const termStart = dateStr(row.term_start), termEnd = dateStr(row.term_end);
        return {
          id: Number(row.id),
          conditionNo: str(row.condition_no),
          name: String(row.name ?? ""),
          party: row.party_id ? { id: Number(row.party_id), name: String(row.party_name ?? "") } : null,
          work: row.work_id ? { id: Number(row.work_id), name: String(row.work_title ?? "") } : null,
          ratePpm: int(row.rate_ppm),
          termStart, termEnd,
          schedulable: !!(termStart && termEnd),
          monthSpan: monthsBetween(termStart, termEnd)
        };
      });
    } catch (error) { throw translate(error); }
  }

  private todayStr(): string {
    return this.today().toISOString().slice(0, 10);
  }
}

// ---------------------------------------------------------------------------

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/**
 * 取引先・作品・案件で絞る節。args に番号を積みながら組む。
 * 月の表も別枠も同じ絞りを通す（片方だけ効くと件数が合わない）。
 */
function narrowBy(scope: ClosingScope, args: unknown[]): string {
  const parts: string[] = [];
  if (scope.partyId) { args.push(scope.partyId); parts.push(`c.counterparty_id = $${args.length}`); }
  if (scope.workId) { args.push(scope.workId); parts.push(`c.work_id = $${args.length}`); }
  if (scope.matterId) {
    args.push(scope.matterId);
    parts.push(`EXISTS (SELECT 1 FROM matter_links ml WHERE ml.matter_id = $${args.length}
                  AND ml.target_type = 'condition' AND ml.target_ref = c.id::text)`);
  }
  return parts.length ? ` AND ${parts.join(" AND ")}` : "";
}

/** 契約期間が何か月あるか。何回ぶん並ぶかの目安に使う。 */
export function monthsBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const a = { y: Number(from.slice(0, 4)), m: Number(from.slice(5, 7)) };
  const b = { y: Number(to.slice(0, 4)), m: Number(to.slice(5, 7)) };
  if (!a.y || !b.y) return null;
  const months = (b.y - a.y) * 12 + (b.m - a.m) + 1;
  return months > 0 ? months : null;
}

function headRow(row: any): CandidateRow {
  const kind = String(row.kind ?? "");
  return {
    id: Number(row.id),
    conditionNo: str(row.condition_no),
    name: String(row.name ?? ""),
    kind,
    pricingModel: String(row.pricing_model ?? "none"),
    direction: String(row.direction ?? "out"),
    currency: String(row.currency ?? "JPY"),
    needsReport: needsReport(row.pricing_model),
    documentLabel: documentFor(kind).label,
    party: row.party_id ? { id: Number(row.party_id), name: String(row.party_name ?? "") } : null,
    work: row.work_id ? { id: Number(row.work_id), name: String(row.work_title ?? "") } : null,
    matter: row.matter_id ? { id: Number(row.matter_id), title: String(row.matter_title ?? "") } : null,
    termStart: dateStr(row.term_start),
    termEnd: dateStr(row.term_end),
    periodCount: Number(row.period_count ?? 0),
    openCount: 0,
    nextClosingOn: null
  };
}

export function periodRow(row: any, today: string, unplanned: boolean): PeriodRow {
  const kind = String(row.kind ?? "");
  const closingOn = dateStr(row.due_on);
  const eventId = int(row.event_id);
  const documentId = int(row.document_id);
  const paymentId = int(row.payment_id);
  const step = stepOf({
    hasEvent: eventId !== null,
    hasDocument: documentId !== null,
    hasPayment: paymentId !== null
  });
  const due = dueOf({
    schedulePayOn: dateStr(row.pay_on),
    printedDueOn: printedDue(row.printed_due_on),
    paymentTerms: str(row.payment_terms),
    basisOn: closingOn ?? dateStr(row.event_on)
  });
  return {
    scheduleId: int(row.schedule_id),
    conditionId: Number(row.condition_id),
    conditionNo: str(row.condition_no),
    conditionName: String(row.condition_name ?? ""),
    kind,
    pricingModel: String(row.pricing_model ?? "none"),
    currency: String(row.currency ?? "JPY"),
    party: row.party_id ? { id: Number(row.party_id), name: String(row.party_name ?? "") } : null,
    matter: row.matter_id ? { id: Number(row.matter_id), title: String(row.matter_title ?? "") } : null,
    seq: int(row.seq),
    label: str(row.label),
    closingOn,
    serviceFrom: dateStr(row.service_from),
    serviceTo: dateStr(row.service_to),
    plannedAmount: int(row.planned_amount),
    eventId,
    eventOn: dateStr(row.event_on),
    eventAmount: int(row.event_amount),
    documentId,
    documentNo: str(row.document_no),
    documentStatus: str(row.document_status),
    documentLabel: documentFor(kind).label,
    paymentId,
    paymentNo: str(row.payment_no),
    paymentStatus: str(row.payment_status),
    paidOn: dateStr(row.paid_on),
    paidAmount: Number(row.allocated_amount ?? 0),
    step,
    state: stateLabel({ step, pricingModel: row.pricing_model, kind }),
    due,
    monthKey: monthKeyOf(closingOn),
    lateDays: step === "done" ? 0 : lateDays(closingOn, today),
    unplanned
  };
}
