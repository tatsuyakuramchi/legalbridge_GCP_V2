import { inTransaction, type Queryable, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";

/**
 * 支払を条件へ割り当てる。
 *
 * これが無いと、支払は「誰にいくら払ったか」までしか分からず、
 * 「どの取り決めに対する支払か」が追えない。債権の未収も出せない。
 *
 * 1件の支払を複数の条件に分けられる。分けた合計は支払額を超えない。
 * 超えると、条件ごとに見た消化額の合計が実際に払った額と食い違う。
 */

export interface Allocation {
  conditionId: number;
  /** どの実績に対する支払か。特定できなければ省く。 */
  eventId?: number | null;
  amount: number;
}

export interface AllocationResult {
  paymentId: number;
  allocated: number;
  /** 支払額のうち、まだどの条件にも割り当てていない分。 */
  unallocated: number;
  lines: Array<{ conditionId: number; conditionNo: string | null; amount: number }>;
}

export class PaymentAllocationService {
  constructor(private readonly database: Transactable) {}

  /**
   * 割り当てを置き換える。差分ではなく全体を渡す形にして、
   * 「足したつもりが二重になる」を起こさない。
   */
  async replace(paymentId: number, lines: Allocation[], actor: string): Promise<AllocationResult> {
    try {
      return await inTransaction(this.database, async (client) => {
        const head = await client.query(
          "SELECT id, amount, currency, party_id, direction FROM payments WHERE id = $1 FOR UPDATE",
          [paymentId]);
        const payment = head.rows[0] as any;
        if (!payment) throw new DomainError("NOT_FOUND", `支払 ${paymentId} が見つかりません`);

        const total = lines.reduce((sum, l) => sum + Math.round(l.amount), 0);
        if (lines.some((l) => Math.round(l.amount) === 0)) {
          throw new DomainError("VALIDATION", "0円の割り当ては置けません。要らない行は外してください");
        }
        if (total > Number(payment.amount)) {
          throw new DomainError("VALIDATION",
            `割り当ての合計 ${total} が支払額 ${payment.amount} を超えています`);
        }

        const seen = new Set<string>();
        for (const l of lines) {
          const key = `${l.conditionId}:${l.eventId ?? ""}`;
          if (seen.has(key)) {
            throw new DomainError("VALIDATION", `同じ条件・実績への割り当てが重複しています（条件 ${l.conditionId}）`);
          }
          seen.add(key);
        }

        await this.assertConditions(client, payment, lines);

        await client.query("DELETE FROM payment_allocations WHERE payment_id = $1", [paymentId]);
        for (const l of lines) {
          await client.query(
            `INSERT INTO payment_allocations (payment_id, condition_id, event_id, amount)
             VALUES ($1, $2, $3, $4)`,
            [paymentId, l.conditionId, l.eventId ?? null, Math.round(l.amount)]);
        }

        const back = await client.query(
          `SELECT al.condition_id, al.amount, c.condition_no
             FROM payment_allocations al JOIN conditions c ON c.id = al.condition_id
            WHERE al.payment_id = $1 ORDER BY c.condition_no NULLS LAST, al.id`, [paymentId]);

        await recordAudit(client, {
          actor, action: "payment.allocate", targetType: "payment", targetId: paymentId,
          detail: { lines: lines.length, allocated: total,
                    unallocated: Number(payment.amount) - total }
        });

        return {
          paymentId,
          allocated: total,
          unallocated: Number(payment.amount) - total,
          lines: (back.rows as any[]).map((x) => ({
            conditionId: Number(x.condition_id), conditionNo: x.condition_no ?? null,
            amount: Number(x.amount)
          }))
        };
      });
    } catch (error) { throw translate(error); }
  }

  /** 割り当て先の候補。その支払の相手先の条件だけを出す。 */
  async candidates(paymentId: number) {
    try {
      const r = await this.database.query(
        `SELECT c.id, c.condition_no, c.name, c.direction, c.currency, c.flat_amount,
                COALESCE(a.allocated, 0) AS already_allocated
           FROM payments y
           JOIN v_party_resolved pr ON pr.party_id = y.party_id
           JOIN conditions c ON c.status = 'active'
           JOIN v_party_resolved cp ON cp.party_id = c.counterparty_id
                                   AND cp.resolved_id = pr.resolved_id
           LEFT JOIN LATERAL (
             SELECT SUM(amount) AS allocated FROM payment_allocations
              WHERE condition_id = c.id
           ) a ON true
          WHERE y.id = $1 AND c.currency = y.currency
          ORDER BY c.condition_no NULLS LAST, c.id`, [paymentId]);
      return (r.rows as any[]).map((x) => ({
        id: Number(x.id), conditionNo: x.condition_no ?? null, name: String(x.name),
        direction: String(x.direction), currency: String(x.currency),
        flatAmount: x.flat_amount === null ? null : Number(x.flat_amount),
        alreadyAllocated: Number(x.already_allocated ?? 0)
      }));
    } catch (error) { throw translate(error); }
  }

  private async assertConditions(client: Queryable, payment: any, lines: Allocation[]) {
    if (!lines.length) return;
    const ids = [...new Set(lines.map((l) => l.conditionId))];
    const r = await client.query(
      `SELECT c.id, c.currency, c.status, pr.resolved_id AS party_resolved
         FROM conditions c
         JOIN v_party_resolved pr ON pr.party_id = c.counterparty_id
        WHERE c.id = ANY($1::bigint[])`, [ids]);
    const rows = r.rows as any[];

    const payerResolved = await client.query(
      "SELECT resolved_id FROM v_party_resolved WHERE party_id = $1", [payment.party_id]);
    const payer = Number((payerResolved.rows[0] as any)?.resolved_id ?? payment.party_id);

    for (const id of ids) {
      const c = rows.find((x) => Number(x.id) === id);
      if (!c) throw new DomainError("NOT_FOUND", `条件 ${id} が見つかりません`);
      if (c.status !== "active") {
        throw new DomainError("VALIDATION", `条件 ${id} は ${c.status} です。有効な条件にだけ割り当てられます`);
      }
      if (String(c.currency) !== String(payment.currency)) {
        throw new DomainError("VALIDATION",
          `条件 ${id} の通貨（${c.currency}）が支払（${payment.currency}）と違います`);
      }
      if (Number(c.party_resolved) !== payer) {
        // 相手先が違う支払を条件に付けると、条件ごとの消化額が別人の支払で埋まる。
        throw new DomainError("VALIDATION",
          `条件 ${id} の相手先が支払の相手先と違います`);
      }
    }
  }
}
