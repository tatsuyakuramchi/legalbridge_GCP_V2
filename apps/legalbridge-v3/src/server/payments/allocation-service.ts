import { dateStr, inTransaction, type Queryable, type Transactable } from "../core/db.js";
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
                COALESCE(c.series_id, c.id) AS series_id,
                COALESCE(a.allocated, 0) AS already_allocated,
                COALESCE(h.here, 0) AS allocated_here
           FROM payments y
           JOIN v_party_resolved pr ON pr.party_id = y.party_id
           JOIN conditions c ON c.status = 'active'
           JOIN v_party_resolved cp ON cp.party_id = c.counterparty_id
                                   AND cp.resolved_id = pr.resolved_id
           -- 条件は版が変わると別の行になる。割当は旧版に付いたまま残る
           -- ことがあるので、金額は版をまたいだ系列で数える。系列で見ないと
           -- 画面は「割当なし」に見え、全体置き換えで保存した瞬間に
           -- 旧版の割当が消える。
           LEFT JOIN LATERAL (
             SELECT SUM(al.amount) AS allocated
               FROM payment_allocations al
               JOIN conditions cx ON cx.id = al.condition_id
              WHERE COALESCE(cx.series_id, cx.id) = COALESCE(c.series_id, c.id)
           ) a ON true
           LEFT JOIN LATERAL (
             SELECT SUM(al.amount) AS here
               FROM payment_allocations al
               JOIN conditions cx ON cx.id = al.condition_id
              WHERE COALESCE(cx.series_id, cx.id) = COALESCE(c.series_id, c.id)
                AND al.payment_id = y.id
           ) h ON true
          WHERE y.id = $1 AND c.currency = y.currency
          ORDER BY c.condition_no NULLS LAST, c.id`, [paymentId]);

      // その条件の実績と、この支払がいまどの実績を指しているか。
      //
      // 画面は条件ごとに1行なので、実績を返さないと保存のときに実績への
      // 結びつきが落ちる。落ちると、同じ検収書からもう1件支払を立てられて
      // しまう（二重払いの見張りは割当の実績で効いているため）。
      const ids = (r.rows as any[]).map((x) => Number(x.id));
      const events = ids.length
        ? await this.database.query(
            `SELECT e.id, COALESCE(x.series_id, x.id) AS series_id,
                    e.occurred_on, e.amount, d.document_no,
                    (a.payment_id IS NOT NULL) AS picked
               FROM condition_events e
               JOIN conditions x ON x.id = e.condition_id
               LEFT JOIN documents d ON d.id = e.document_id
               LEFT JOIN payment_allocations a
                      ON a.event_id = e.id AND a.payment_id = $2
              WHERE COALESCE(x.series_id, x.id) IN (
                      SELECT COALESCE(y2.series_id, y2.id) FROM conditions y2
                       WHERE y2.id = ANY($1::bigint[]))
                AND e.status = 'active'
              ORDER BY e.occurred_on NULLS LAST, e.id`, [ids, paymentId])
        : { rows: [] as any[] };

      // 束ねる鍵は条件の ID ではなく系列。条件 ID で束ねると、旧版に付いた
      // ままの実績が改訂版の行に出てこず、付け替えようがなくなる。
      const bySeries = new Map<number, any[]>();
      for (const e of events.rows as any[]) {
        const key = Number(e.series_id);
        bySeries.set(key, [...(bySeries.get(key) ?? []), {
          id: Number(e.id),
          // pg は date 列を Date で返す。String() で切ると「Fri Sep 25」になる。
          occurredOn: dateStr(e.occurred_on),
          amount: Number(e.amount ?? 0),
          documentNo: e.document_no ?? null,
          picked: e.picked === true
        }]);
      }
      return (r.rows as any[]).map((x) => ({
        id: Number(x.id), conditionNo: x.condition_no ?? null, name: String(x.name),
        direction: String(x.direction), currency: String(x.currency),
        flatAmount: x.flat_amount === null ? null : Number(x.flat_amount),
        alreadyAllocated: Number(x.already_allocated ?? 0),
        // この支払がいまこの系列に割り当てている額。画面はこれを初期値に
        // する。条件番号の一致で探すと改訂版の行に入らない。
        allocatedHere: Number(x.allocated_here ?? 0),
        events: bySeries.get(Number(x.series_id)) ?? []
      }));
    } catch (error) { throw translate(error); }
  }

  private async assertConditions(client: Queryable, payment: any, lines: Allocation[]) {
    if (!lines.length) return;
    const ids = [...new Set(lines.map((l) => l.conditionId))];
    const r = await client.query(
      `SELECT c.id, c.currency, c.status, pr.resolved_id AS party_resolved,
              COALESCE(c.series_id, c.id) AS series_id
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

    await this.assertEvents(client, lines, rows);
  }

  /**
   * 「どの実績に対する支払か」の指し先を確かめる。
   *
   * ここが違う実績や無効な実績を指すと、二重払いの見張り（割当の実績で
   * 効いている）がすり抜ける。指した先が別の条件の実績なら、その検収書は
   * 支払が立っていないように見え、もう1件立てられてしまう。
   */
  private async assertEvents(
    client: Queryable, lines: Allocation[],
    conditions: Array<{ id: unknown; series_id: unknown }>
  ) {
    const eventIds = [...new Set(
      lines.map((l) => l.eventId).filter((x): x is number => typeof x === "number"))];
    if (!eventIds.length) return;

    const r = await client.query(
      `SELECT e.id, e.status, COALESCE(x.series_id, x.id) AS series_id
         FROM condition_events e
         JOIN conditions x ON x.id = e.condition_id
        WHERE e.id = ANY($1::bigint[])`, [eventIds]);
    const found = r.rows as any[];

    // 条件は版をまたいで同じ系列。旧版の実績を改訂版の割当に付けるのは正しい。
    const seriesOf = new Map<number, number>();
    for (const c of conditions) seriesOf.set(Number(c.id), Number(c.series_id));

    for (const l of lines) {
      if (typeof l.eventId !== "number") continue;
      const e = found.find((x) => Number(x.id) === l.eventId);
      if (!e) throw new DomainError("NOT_FOUND", `実績 ${l.eventId} が見つかりません`);
      if (String(e.status) !== "active") {
        throw new DomainError("VALIDATION",
          `実績 ${l.eventId} は無効です。有効な実績にだけ結べます`);
      }
      if (Number(e.series_id) !== seriesOf.get(l.conditionId)) {
        throw new DomainError("VALIDATION",
          `実績 ${l.eventId} は条件 ${l.conditionId} の実績ではありません`);
      }
    }
  }
}
