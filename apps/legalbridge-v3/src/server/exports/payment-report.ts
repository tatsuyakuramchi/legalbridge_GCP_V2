import type { Transactable } from "../core/db.js";
import { dateStr, str } from "../core/db.js";
import { translate } from "../core/errors.js";

/**
 * 支払報告書。
 *
 * 相手先ごとに、期間内の支払を明細と合計で出す。相手先へ送る「この期間に
 * これだけ払いました」の控えであり、経理の突き合わせにも使う。
 *
 * 合計は明細から足し直す（保存された合計は持たない）。二重に持つと、
 * 明細を直したときに合計だけ古いという V2 の問題を持ち込むことになる。
 */

export interface PaymentReportLine {
  paymentNo: string | null;
  conditions: string | null;
  amount: number;
  taxAmount: number;
  withholdingAmount: number;
  netAmount: number;
  dueOn: string | null;
  paidOn: string | null;
  status: string;
  note: string | null;
}

export interface PaymentReportGroup {
  partyId: number;
  partyName: string;
  partyKind: "corporate" | "individual";
  invoiceNo: string | null;
  currency: string;
  lines: PaymentReportLine[];
  total: { amount: number; taxAmount: number; withholdingAmount: number; netAmount: number };
}

export interface CurrencyTotal {
  currency: string;
  amount: number; taxAmount: number; withholdingAmount: number; netAmount: number; count: number;
}

export interface PaymentReport {
  from: string;
  to: string;
  basis: "due" | "paid";
  groups: PaymentReportGroup[];
  /**
   * 総計は通貨ごとに分ける。異なる通貨を足した数字は意味を持たないので、
   * 1本の合計にはしない。
   */
  totals: CurrencyTotal[];
  count: number;
}

const zero = () => ({ amount: 0, taxAmount: 0, withholdingAmount: 0, netAmount: 0 });

export class PaymentReportRepository {
  constructor(private readonly database: Transactable) {}

  /**
   * @param basis どの日付で期間を切るか。`paid`＝実際に払った日（経理の月次）、
   *              `due`＝期日（これから払う分の確認）。
   */
  async build(input: {
    from: string; to: string; basis?: "due" | "paid"; partyId?: number | null;
  }): Promise<PaymentReport> {
    const basis = input.basis ?? "paid";
    const column = basis === "paid" ? "y.paid_on" : "y.due_on";
    try {
      const r = await this.database.query(
        `SELECT y.id, y.payment_no, y.currency, y.amount, y.tax_amount, y.withholding_amount,
                y.due_on, y.paid_on, y.status, y.note,
                p.id AS party_id, p.name AS party_name, p.kind AS party_kind, p.invoice_no,
                (SELECT string_agg(c.condition_no, ' / ' ORDER BY c.condition_no)
                   FROM payment_allocations al JOIN conditions c ON c.id = al.condition_id
                  WHERE al.payment_id = y.id) AS conditions
           FROM payments y JOIN parties p ON p.id = y.party_id
          WHERE y.direction = 'out'
            AND ${column} BETWEEN $1::date AND $2::date
            AND ($3::bigint IS NULL OR p.id = $3::bigint)
          ORDER BY p.name, ${column}, y.id`,
        [input.from, input.to, input.partyId ?? null]);

      const groups = new Map<number, PaymentReportGroup>();
      const totals = new Map<string, CurrencyTotal>();
      let count = 0;

      for (const row of r.rows as any[]) {
        const amount = Number(row.amount ?? 0);
        const taxAmount = Number(row.tax_amount ?? 0);
        const withholdingAmount = Number(row.withholding_amount ?? 0);
        const netAmount = amount + taxAmount - withholdingAmount;

        const partyId = Number(row.party_id);
        let group = groups.get(partyId);
        if (!group) {
          group = {
            partyId, partyName: String(row.party_name),
            partyKind: row.party_kind === "individual" ? "individual" : "corporate",
            invoiceNo: str(row.invoice_no), currency: String(row.currency ?? "JPY"),
            lines: [], total: zero()
          };
          groups.set(partyId, group);
        }
        group.lines.push({
          paymentNo: str(row.payment_no), conditions: str(row.conditions),
          amount, taxAmount, withholdingAmount, netAmount,
          dueOn: dateStr(row.due_on), paidOn: dateStr(row.paid_on),
          status: String(row.status), note: str(row.note)
        });
        group.total.amount += amount;
        group.total.taxAmount += taxAmount;
        group.total.withholdingAmount += withholdingAmount;
        group.total.netAmount += netAmount;

        const currency = String(row.currency ?? "JPY");
        let sum = totals.get(currency);
        if (!sum) {
          sum = { currency, ...zero(), count: 0 };
          totals.set(currency, sum);
        }
        sum.amount += amount;
        sum.taxAmount += taxAmount;
        sum.withholdingAmount += withholdingAmount;
        sum.netAmount += netAmount;
        sum.count += 1;
        count += 1;
      }

      return {
        from: input.from, to: input.to, basis,
        groups: [...groups.values()], totals: [...totals.values()], count
      };
    } catch (error) { throw translate(error); }
  }
}
