import type { DatabasePool } from "../db/pool.js";
import { computeReceiptRoyalty, resolveDistribution } from "./receipt.js";
import { planPaymentSync, type PaymentIntent, type PaymentSyncContext } from "./payment-sync.js";

// 再許諾料の受領記録（condition_receipts）の作成・更新。
//   - 受領再許諾料 / 上流分配はサーバが condition_lines の料率から再計算。
//   - opts.syncPayments が真なら、同一トランザクションで payments 台帳へ同期
//     （受領→inbound/sublicense_income、分配→outbound/royalty）。同期は planPaymentSync
//     が算出した意図に基づく（no-DELETE：クリアは金額ゼロUPDATE）。
// 台帳同期は追加 capability（grant 016・scope 'payments'）が有効な時のみ。
// DELETE は行わない。

export interface ReceiptWriteInput {
  period?: string | null;
  periodDate?: string | null;
  reportedSales?: number | null;
  reportedQuantity?: number | null;
  receivedAmount?: number | null;
  receivedDate?: string | null;
  note?: string | null;
  calcType?: string | null;
  distributionBase?: number | null;
  distributionQty?: number | null;
}

export interface ReceiptWriteOptions {
  syncPayments?: boolean;
}

export interface SavedReceipt {
  id: number;
  conditionLineId: number;
  period: string | null;
  computedRoyaltyExTax: number;
  receivedAmount: number | null;
  status: "reported" | "received";
  computedDistributionExTax: number | null;
  distributionBase: number;
  distributionQty: number;
  paymentsSynced: number; // 同期した台帳件数（0=未同期）
}

export interface ReceiptRepository {
  create(conditionLineId: number, input: ReceiptWriteInput, opts?: ReceiptWriteOptions): Promise<SavedReceipt>;
  update(receiptId: number, input: ReceiptWriteInput, opts?: ReceiptWriteOptions): Promise<SavedReceipt>;
}

export class ReceiptReferenceError extends Error {}

function statusFor(receivedAmount: number | null | undefined): "reported" | "received" {
  return receivedAmount != null ? "received" : "reported";
}

type ConditionTerms = {
  ratePct: number | null;
  unitPrice: number | null;
  parentLicenseConditionId: number | null;
  parentRatePct: number | null;
  sourceWorkId: number | null;
  counterpartyVendorId: number | null;
  currency: string | null;
  parentCounterpartyVendorId: number | null;
  parentCurrency: string | null;
};

function computeValues(cond: ConditionTerms, input: ReceiptWriteInput) {
  const terms = { calcType: input.calcType ?? null, ratePct: cond.ratePct, unitPrice: cond.unitPrice };
  const report = { reportedSales: input.reportedSales, reportedQuantity: input.reportedQuantity };
  const royalty = computeReceiptRoyalty(terms, report);
  const dist = resolveDistribution({
    cond: terms, report, computedRoyaltyExTax: royalty, receivedAmount: input.receivedAmount,
    parentRatePct: cond.parentRatePct, baseOverride: input.distributionBase, qtyOverride: input.distributionQty
  });
  return { royalty, dist };
}

function syncContext(
  receiptId: number, cond: ConditionTerms, input: ReceiptWriteInput,
  dist: { distribution: number | null }, existingPaymentId: number | null, existingDistributionPaymentId: number | null
): PaymentSyncContext {
  return {
    receiptId,
    workId: cond.sourceWorkId,
    currency: cond.currency,
    receivedAmount: input.receivedAmount ?? null,
    receivedDate: input.receivedDate ?? null,
    counterpartyVendorId: cond.counterpartyVendorId,
    existingPaymentId,
    distribution: dist.distribution,
    parentCounterpartyVendorId: cond.parentCounterpartyVendorId,
    parentCurrency: cond.parentCurrency,
    existingDistributionPaymentId,
    period: input.period ?? null
  };
}

export class PgReceiptRepository implements ReceiptRepository {
  constructor(private readonly database: DatabasePool) {}

  async create(conditionLineId: number, input: ReceiptWriteInput, opts: ReceiptWriteOptions = {}) {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const cond = await this.readTerms(client, conditionLineId);
      const { royalty, dist } = computeValues(cond, input);
      const status = statusFor(input.receivedAmount);
      const inserted = await client.query(
        `INSERT INTO condition_receipts (
           condition_line_id, period, period_date, reported_sales, reported_quantity,
           computed_royalty_ex_tax, received_amount, received_date, status, note,
           distribution_base, distribution_qty, distribution_rate_pct,
           computed_distribution_ex_tax, distribution_parent_condition_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING id`,
        [
          conditionLineId, input.period ?? null, input.periodDate ?? null,
          input.reportedSales ?? null, input.reportedQuantity ?? null, royalty,
          input.receivedAmount ?? null, input.receivedDate ?? null, status, input.note ?? null,
          dist.base, dist.qty, cond.parentRatePct, dist.distribution, cond.parentLicenseConditionId
        ]
      );
      const receiptId = Number(inserted.rows[0].id);
      let synced = 0;
      if (opts.syncPayments) {
        const intents = planPaymentSync(syncContext(receiptId, cond, input, dist, null, null));
        synced = await this.executeIntents(client, receiptId, intents);
      }
      await client.query("COMMIT");
      return this.saved(receiptId, conditionLineId, input, royalty, dist, status, synced);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async update(receiptId: number, input: ReceiptWriteInput, opts: ReceiptWriteOptions = {}) {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query(
        "SELECT condition_line_id, payment_id, distribution_payment_id FROM condition_receipts WHERE id = $1 FOR UPDATE",
        [receiptId]
      );
      if (!existing.rows[0]?.condition_line_id) {
        throw new ReceiptReferenceError("receipt not found");
      }
      const conditionLineId = Number(existing.rows[0].condition_line_id);
      const paymentId = existing.rows[0].payment_id == null ? null : Number(existing.rows[0].payment_id);
      const distributionPaymentId = existing.rows[0].distribution_payment_id == null ? null : Number(existing.rows[0].distribution_payment_id);
      const cond = await this.readTerms(client, conditionLineId);
      const { royalty, dist } = computeValues(cond, input);
      const status = statusFor(input.receivedAmount);
      await client.query(
        `UPDATE condition_receipts SET
            period = $2, period_date = $3, reported_sales = $4, reported_quantity = $5,
            computed_royalty_ex_tax = $6, received_amount = $7, received_date = $8,
            status = $9, note = $10,
            distribution_base = $11, distribution_qty = $12, distribution_rate_pct = $13,
            computed_distribution_ex_tax = $14, distribution_parent_condition_id = $15,
            updated_at = now()
          WHERE id = $1`,
        [
          receiptId, input.period ?? null, input.periodDate ?? null,
          input.reportedSales ?? null, input.reportedQuantity ?? null, royalty,
          input.receivedAmount ?? null, input.receivedDate ?? null, status, input.note ?? null,
          dist.base, dist.qty, cond.parentRatePct, dist.distribution, cond.parentLicenseConditionId
        ]
      );
      let synced = 0;
      if (opts.syncPayments) {
        const intents = planPaymentSync(syncContext(receiptId, cond, input, dist, paymentId, distributionPaymentId));
        synced = await this.executeIntents(client, receiptId, intents);
      }
      await client.query("COMMIT");
      return this.saved(receiptId, conditionLineId, input, royalty, dist, status, synced);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async executeIntents(
    client: { query: (text: string, params: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
    receiptId: number,
    intents: PaymentIntent[]
  ): Promise<number> {
    for (const intent of intents) {
      if (intent.action === "zero") {
        await client.query(
          "UPDATE payments SET amount_ex_tax = 0, total_amount = 0 WHERE id = $1",
          [intent.existingPaymentId]
        );
        continue;
      }
      if (intent.existingPaymentId != null) {
        await client.query(
          `UPDATE payments SET amount_ex_tax = $2, total_amount = $2, paid_date = $3,
                  period = $4, counterparty_vendor_id = $5, currency = $6, status = $7 WHERE id = $1`,
          [intent.existingPaymentId, intent.amountExTax, intent.paidDate, intent.period,
            intent.counterpartyVendorId, intent.currency, intent.status]
        );
      } else {
        const inserted = await client.query(
          `INSERT INTO payments (
             payment_no, direction, payment_kind, work_id, counterparty_vendor_id,
             period, amount_ex_tax, total_amount, currency, status, paid_date, source_document_number
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11) RETURNING id`,
          [intent.paymentNo, intent.direction, intent.paymentKind, intent.workId, intent.counterpartyVendorId,
            intent.period, intent.amountExTax, intent.currency, intent.status, intent.paidDate, intent.sourceDocumentNumber]
        );
        const pid = Number(inserted.rows[0].id);
        // 逆FK：受領行へ payment_id / distribution_payment_id を書き戻す（固定列名）。
        const column = intent.kind === "inbound" ? "payment_id" : "distribution_payment_id";
        await client.query(`UPDATE condition_receipts SET ${column} = $2 WHERE id = $1`, [receiptId, pid]);
      }
    }
    return intents.length;
  }

  private saved(
    id: number, conditionLineId: number, input: ReceiptWriteInput, royalty: number,
    dist: { base: number; qty: number; distribution: number | null }, status: "reported" | "received", synced: number
  ): SavedReceipt {
    return {
      id, conditionLineId, period: input.period ?? null, computedRoyaltyExTax: royalty,
      receivedAmount: input.receivedAmount ?? null, status,
      computedDistributionExTax: dist.distribution, distributionBase: dist.base, distributionQty: dist.qty,
      paymentsSynced: synced
    };
  }

  private async readTerms(
    client: { query: (text: string, params: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
    conditionLineId: number
  ): Promise<ConditionTerms> {
    const row = await client.query(
      `SELECT rate_pct, unit_price, parent_license_condition_id,
              source_work_id, counterparty_vendor_id, currency
         FROM condition_lines WHERE id = $1`,
      [conditionLineId]
    );
    if (!row.rows[0]) throw new ReceiptReferenceError("condition line not found");
    const r = row.rows[0];
    const parentId = r.parent_license_condition_id == null ? null : Number(r.parent_license_condition_id);
    let parentRate: number | null = null;
    let parentVendor: number | null = null;
    let parentCurrency: string | null = null;
    if (parentId != null) {
      const parent = await client.query(
        "SELECT rate_pct, counterparty_vendor_id, currency FROM condition_lines WHERE id = $1",
        [parentId]
      );
      const p = parent.rows[0];
      if (p) {
        parentRate = p.rate_pct == null ? null : Number(p.rate_pct);
        parentVendor = p.counterparty_vendor_id == null ? null : Number(p.counterparty_vendor_id);
        parentCurrency = (p.currency as string) ?? null;
      }
    }
    return {
      ratePct: r.rate_pct == null ? null : Number(r.rate_pct),
      unitPrice: r.unit_price == null ? null : Number(r.unit_price),
      parentLicenseConditionId: parentId,
      parentRatePct: parentRate,
      sourceWorkId: r.source_work_id == null ? null : Number(r.source_work_id),
      counterpartyVendorId: r.counterparty_vendor_id == null ? null : Number(r.counterparty_vendor_id),
      currency: (r.currency as string) ?? null,
      parentCounterpartyVendorId: parentVendor,
      parentCurrency
    };
  }
}

export class MemoryReceiptRepository implements ReceiptRepository {
  private sequence = 1;
  private paymentSeq = 1;
  readonly receipts: Array<SavedReceipt & { note: string | null; paymentId: number | null; distributionPaymentId: number | null; conditionLineId: number }> = [];
  readonly payments: Array<{ id: number; kind: string; amountExTax: number }> = [];

  constructor(private readonly conditions = new Map<number, ConditionTerms>([
    [1, {
      ratePct: 10, unitPrice: 500, parentLicenseConditionId: null, parentRatePct: null,
      sourceWorkId: 42, counterpartyVendorId: 18, currency: "JPY",
      parentCounterpartyVendorId: null, parentCurrency: null
    }]
  ])) {}

  async create(conditionLineId: number, input: ReceiptWriteInput, opts: ReceiptWriteOptions = {}) {
    const cond = this.conditions.get(conditionLineId);
    if (!cond) throw new ReceiptReferenceError("condition line not found");
    return this.persist(this.sequence++, conditionLineId, cond, input, opts, null, null);
  }

  async update(receiptId: number, input: ReceiptWriteInput, opts: ReceiptWriteOptions = {}) {
    const existing = this.receipts.find((r) => r.id === receiptId);
    if (!existing) throw new ReceiptReferenceError("receipt not found");
    const cond = this.conditions.get(existing.conditionLineId);
    if (!cond) throw new ReceiptReferenceError("condition line not found");
    this.receipts.splice(this.receipts.indexOf(existing), 1);
    return this.persist(receiptId, existing.conditionLineId, cond, input, opts, existing.paymentId, existing.distributionPaymentId);
  }

  private persist(
    id: number, conditionLineId: number, cond: ConditionTerms, input: ReceiptWriteInput,
    opts: ReceiptWriteOptions, existingPaymentId: number | null, existingDistributionPaymentId: number | null
  ): SavedReceipt {
    const { royalty, dist } = computeValues(cond, input);
    let paymentId = existingPaymentId;
    let distributionPaymentId = existingDistributionPaymentId;
    let synced = 0;
    if (opts.syncPayments) {
      const intents = planPaymentSync(syncContext(id, cond, input, dist, existingPaymentId, existingDistributionPaymentId));
      synced = intents.length;
      for (const intent of intents) {
        if (intent.action === "zero") continue;
        if (intent.existingPaymentId == null) {
          const pid = this.paymentSeq++;
          this.payments.push({ id: pid, kind: intent.kind, amountExTax: intent.amountExTax });
          if (intent.kind === "inbound") paymentId = pid; else distributionPaymentId = pid;
        }
      }
    }
    const saved = {
      id, conditionLineId, period: input.period ?? null, computedRoyaltyExTax: royalty,
      receivedAmount: input.receivedAmount ?? null, status: statusFor(input.receivedAmount),
      computedDistributionExTax: dist.distribution, distributionBase: dist.base, distributionQty: dist.qty,
      paymentsSynced: synced, note: input.note ?? null, paymentId, distributionPaymentId
    };
    this.receipts.push(saved);
    return saved;
  }
}
