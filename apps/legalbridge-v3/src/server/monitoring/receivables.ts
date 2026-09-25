import type { Transactable } from "../core/db.js";
import { dateStr, str } from "../core/db.js";
import { translate } from "../core/errors.js";

/**
 * 債権マップ。許諾（OUT条件）で得るはずの金額と、実際に入った金額の差を見る。
 *
 * 「得るはず」は計算書（statements）の正味額の累計。計算書を出していない
 * 期間は債権として立っていないので数えない。見込みで水増しすると、
 * 取り立てるべき額が分からなくなる。
 *
 * 相手先は統合を辿って解決する（v_party_resolved）。名寄せ前の相手先で
 * 分かれたままだと、同じ相手への債権が二重に見える。
 */

export interface ReceivableRow {
  conditionId: number;
  conditionNo: string | null;
  conditionName: string;
  partyId: number;
  partyName: string;
  workTitle: string | null;
  currency: string;
  /** 計算書の正味額の累計。 */
  billed: number;
  /** 入金の累計。 */
  received: number;
  /** 未収。 */
  outstanding: number;
  /** 未収のうち期日を過ぎている分。 */
  overdue: number;
  oldestDueOn: string | null;
  statements: number;
}

export interface ReceivableSummary {
  currency: string;
  billed: number; received: number; outstanding: number; overdue: number; conditions: number;
}

export class ReceivableRepository {
  constructor(private readonly database: Transactable) {}

  async map(): Promise<{ rows: ReceivableRow[]; totals: ReceivableSummary[] }> {
    try {
      const r = await this.database.query(
        `WITH billed AS (
           SELECT s.condition_id, s.currency,
                  SUM(s.net_amount) AS billed, count(*)::int AS statements
             FROM statements s
             JOIN documents d ON d.id = s.document_id
            WHERE d.status <> 'void'          -- 無効にした計算書は債権にしない
            GROUP BY s.condition_id, s.currency
         ), received AS (
           SELECT al.condition_id, y.currency, SUM(al.amount) AS received
             FROM payment_allocations al
             JOIN payments y ON y.id = al.payment_id
            WHERE y.direction = 'in' AND y.status = 'paid'
            GROUP BY al.condition_id, y.currency
         ), due AS (
           SELECT al.condition_id,
                  SUM(al.amount) FILTER (
                    WHERE y.status <> 'paid' AND y.due_on IS NOT NULL AND y.due_on < current_date
                  ) AS overdue,
                  MIN(y.due_on) FILTER (WHERE y.status <> 'paid') AS oldest_due_on
             FROM payment_allocations al
             JOIN payments y ON y.id = al.payment_id
            WHERE y.direction = 'in'
            GROUP BY al.condition_id
         )
         SELECT c.id, c.condition_no, c.name, c.currency,
                pr.resolved_id AS party_id, pr.resolved_name AS party_name,
                w.title AS work_title,
                COALESCE(b.billed, 0)   AS billed,
                COALESCE(rc.received, 0) AS received,
                COALESCE(b.statements, 0) AS statements,
                COALESCE(d.overdue, 0)  AS overdue,
                d.oldest_due_on
           FROM conditions c
           JOIN v_party_resolved pr ON pr.party_id = c.counterparty_id
           LEFT JOIN works w ON w.id = c.work_id
           LEFT JOIN billed b   ON b.condition_id = c.id
           LEFT JOIN received rc ON rc.condition_id = c.id
           LEFT JOIN due d      ON d.condition_id = c.id
          WHERE c.direction = 'out' AND c.status = 'active'
            AND (COALESCE(b.billed, 0) <> 0 OR COALESCE(rc.received, 0) <> 0)
          ORDER BY (COALESCE(b.billed, 0) - COALESCE(rc.received, 0)) DESC, c.id`);

      const rows: ReceivableRow[] = (r.rows as any[]).map((x) => {
        const billed = Number(x.billed ?? 0);
        const received = Number(x.received ?? 0);
        return {
          conditionId: Number(x.id), conditionNo: str(x.condition_no),
          conditionName: String(x.name),
          partyId: Number(x.party_id), partyName: String(x.party_name),
          workTitle: str(x.work_title), currency: String(x.currency ?? "JPY"),
          billed, received, outstanding: billed - received,
          overdue: Number(x.overdue ?? 0),
          oldestDueOn: dateStr(x.oldest_due_on),
          statements: Number(x.statements ?? 0)
        };
      });

      // 総計は通貨ごと。異なる通貨を足した数字は意味を持たない。
      const totals = new Map<string, ReceivableSummary>();
      for (const row of rows) {
        let t = totals.get(row.currency);
        if (!t) {
          t = { currency: row.currency, billed: 0, received: 0, outstanding: 0, overdue: 0, conditions: 0 };
          totals.set(row.currency, t);
        }
        t.billed += row.billed;
        t.received += row.received;
        t.outstanding += row.outstanding;
        t.overdue += row.overdue;
        t.conditions += 1;
      }

      return { rows, totals: [...totals.values()] };
    } catch (error) { throw translate(error); }
  }
}
