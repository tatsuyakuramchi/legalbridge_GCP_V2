import type { DatabasePool } from "../db/pool.js";
import { buildPaymentReport, type PaymentReport, type PaymentReportInput } from "./payment-report.js";

// 支払報告書の読み取り。出金台帳（payments outbound）＋取引先（源泉フラグ）を
// 集めて buildPaymentReport に渡す。read-only。権限不足・未整備（42501/42P01/42703）
// では空で縮退する。payments SELECT（grant 016）と vendors SELECT（既存）を使う。

export interface PaymentReportRepository {
  list(period?: string): Promise<PaymentReport>;
}

const EMPTY: PaymentReport = {
  lines: [],
  totals: { subtotalExTax: 0, consumptionTax: 0, withholdingTax: 0, netTransfer: 0, count: 0 }
};

export class PgPaymentReportRepository implements PaymentReportRepository {
  constructor(private readonly database: DatabasePool) {}

  async list(period?: string): Promise<PaymentReport> {
    const params: unknown[] = [];
    let periodClause = "";
    if (period) {
      params.push(period);
      periodClause = `AND p.period = $${params.length}`;
    }
    try {
      const result = await this.database.query(
        `SELECT p.id, p.period, p.currency, p.amount_ex_tax, p.tax_rate,
                v.vendor_name, v.vendor_code, v.entity_type,
                v.withholding_enabled, v.invoice_registration_number
           FROM payments p
           LEFT JOIN vendors v ON v.id = p.counterparty_vendor_id
          WHERE p.direction = 'outbound' ${periodClause}
          ORDER BY p.period DESC NULLS LAST, p.id DESC
          LIMIT 1000`,
        params
      );
      const inputs: PaymentReportInput[] = result.rows.map((row) => ({
        paymentId: Number(row.id),
        vendorName: (row.vendor_name as string) ?? null,
        vendorCode: (row.vendor_code as string) ?? null,
        entityType: (row.entity_type as string) ?? null,
        vendorWithholdingEnabled: row.withholding_enabled == null ? null : Boolean(row.withholding_enabled),
        invoiceRegistrationNumber: (row.invoice_registration_number as string) ?? null,
        period: (row.period as string) ?? null,
        currency: (row.currency as string) ?? null,
        amountExTax: Number(row.amount_ex_tax ?? 0),
        taxRatePct: row.tax_rate == null ? null : Number(row.tax_rate)
      }));
      return buildPaymentReport(inputs);
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === "42501" || code === "42P01" || code === "42703") return EMPTY;
      throw error;
    }
  }
}

export class MemoryPaymentReportRepository implements PaymentReportRepository {
  constructor(private readonly rows: PaymentReportInput[] = []) {}

  async list(period?: string): Promise<PaymentReport> {
    const filtered = period ? this.rows.filter((r) => r.period === period) : this.rows;
    return buildPaymentReport(filtered);
  }
}
