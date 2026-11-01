import type { Queryable } from "../core/db.js";
import { dateStr, str } from "../core/db.js";

/**
 * 「支払が立っているので止めた」ときに、どの支払かを返す（DomainError の detail.blockingPayments）。
 * 画面はこれを読んで、その場で「この支払を取り消して続ける」を出す（client/PaymentBlock.tsx）。
 */
export interface BlockingPayment { id: number; paymentNo: string | null; status: string; amount: number; dueOn: string | null; paidOn: string | null }

export async function blockingPayments(q: Queryable, where: { eventIds?: number[]; conditionSeriesOf?: number }): Promise<BlockingPayment[]> {
  const r = where.eventIds
    ? await q.query(
        `SELECT DISTINCT p.id, p.payment_no, p.status, p.amount, p.due_on, p.paid_on
           FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
          WHERE a.event_id = ANY($1::bigint[]) AND p.status <> 'canceled' ORDER BY p.id`, [where.eventIds])
    : await q.query(
        `SELECT DISTINCT p.id, p.payment_no, p.status, p.amount, p.due_on, p.paid_on
           FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
          WHERE p.status <> 'canceled'
            AND a.condition_id IN (SELECT x.id FROM conditions x, conditions c
                                    WHERE c.id = $1 AND COALESCE(x.series_id, x.id) = COALESCE(c.series_id, c.id))
          ORDER BY p.id`, [where.conditionSeriesOf]);
  return (r.rows as Array<Record<string, unknown>>).map((p) => ({
    id: Number(p.id), paymentNo: str(p.payment_no), status: String(p.status), amount: Number(p.amount ?? 0),
    dueOn: dateStr(p.due_on), paidOn: dateStr(p.paid_on)
  }));
}
