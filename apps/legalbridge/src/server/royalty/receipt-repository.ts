import type { DatabasePool } from "../db/pool.js";
import { computeReceiptRoyalty, type ReceiptCondition } from "./receipt.js";

// 再許諾料の受領記録（condition_receipts）の作成・更新。
// V1 workModel.ts の受領CRUDに倣うが、受領再許諾料（computed_royalty_ex_tax）は
// サーバが condition_lines の rate_pct / unit_price（DB由来）＋リクエストの
// calcType / 報告値から再計算する（フロントの金額は信用しない）。
//
// スキーマ（0042 + 0101 + 0115）：
//   - condition_line_id → condition_lines（0101で cfc から付替え・正準FK）
//   - period / period_date / reported_sales / reported_quantity /
//     computed_royalty_ex_tax / received_amount / received_date / status / note
// DELETE は行わない。payments 台帳同期・分配（0115列）は別スライス。

export interface ReceiptWriteInput {
  period?: string | null;
  periodDate?: string | null;      // YYYY-MM-DD
  reportedSales?: number | null;
  reportedQuantity?: number | null;
  receivedAmount?: number | null;
  receivedDate?: string | null;
  note?: string | null;
  // 受領再許諾料の再計算に使う条件の性質（qty判定のみ。rate/unitPriceはDBから読む）。
  calcType?: string | null;
}

export interface SavedReceipt {
  id: number;
  conditionLineId: number;
  period: string | null;
  computedRoyaltyExTax: number;
  receivedAmount: number | null;
  status: "reported" | "received";
}

export interface ReceiptRepository {
  create(conditionLineId: number, input: ReceiptWriteInput): Promise<SavedReceipt>;
  update(receiptId: number, input: ReceiptWriteInput): Promise<SavedReceipt>;
}

export class ReceiptReferenceError extends Error {}

function statusFor(receivedAmount: number | null | undefined): "reported" | "received" {
  return receivedAmount != null ? "received" : "reported";
}

export class PgReceiptRepository implements ReceiptRepository {
  constructor(private readonly database: DatabasePool) {}

  async create(conditionLineId: number, input: ReceiptWriteInput) {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const cond = await this.readCondition(client, conditionLineId);
      const royalty = computeReceiptRoyalty(
        { calcType: input.calcType ?? null, ratePct: cond.ratePct, unitPrice: cond.unitPrice },
        { reportedSales: input.reportedSales, reportedQuantity: input.reportedQuantity }
      );
      const status = statusFor(input.receivedAmount);
      const inserted = await client.query(
        `INSERT INTO condition_receipts (
           condition_line_id, period, period_date, reported_sales, reported_quantity,
           computed_royalty_ex_tax, received_amount, received_date, status, note
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [
          conditionLineId, input.period ?? null, input.periodDate ?? null,
          input.reportedSales ?? null, input.reportedQuantity ?? null, royalty,
          input.receivedAmount ?? null, input.receivedDate ?? null, status, input.note ?? null
        ]
      );
      await client.query("COMMIT");
      return {
        id: Number(inserted.rows[0].id),
        conditionLineId,
        period: input.period ?? null,
        computedRoyaltyExTax: royalty,
        receivedAmount: input.receivedAmount ?? null,
        status
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async update(receiptId: number, input: ReceiptWriteInput) {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query(
        "SELECT condition_line_id FROM condition_receipts WHERE id = $1 FOR UPDATE",
        [receiptId]
      );
      if (!existing.rows[0]?.condition_line_id) {
        throw new ReceiptReferenceError("receipt not found");
      }
      const conditionLineId = Number(existing.rows[0].condition_line_id);
      const cond = await this.readCondition(client, conditionLineId);
      const royalty = computeReceiptRoyalty(
        { calcType: input.calcType ?? null, ratePct: cond.ratePct, unitPrice: cond.unitPrice },
        { reportedSales: input.reportedSales, reportedQuantity: input.reportedQuantity }
      );
      const status = statusFor(input.receivedAmount);
      await client.query(
        `UPDATE condition_receipts SET
            period = $2, period_date = $3, reported_sales = $4, reported_quantity = $5,
            computed_royalty_ex_tax = $6, received_amount = $7, received_date = $8,
            status = $9, note = $10, updated_at = now()
          WHERE id = $1`,
        [
          receiptId, input.period ?? null, input.periodDate ?? null,
          input.reportedSales ?? null, input.reportedQuantity ?? null, royalty,
          input.receivedAmount ?? null, input.receivedDate ?? null, status, input.note ?? null
        ]
      );
      await client.query("COMMIT");
      return {
        id: receiptId,
        conditionLineId,
        period: input.period ?? null,
        computedRoyaltyExTax: royalty,
        receivedAmount: input.receivedAmount ?? null,
        status
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async readCondition(
    client: { query: (text: string, params: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
    conditionLineId: number
  ): Promise<{ ratePct: number | null; unitPrice: number | null }> {
    const row = await client.query(
      "SELECT rate_pct, unit_price FROM condition_lines WHERE id = $1",
      [conditionLineId]
    );
    if (!row.rows[0]) throw new ReceiptReferenceError("condition line not found");
    return {
      ratePct: row.rows[0].rate_pct == null ? null : Number(row.rows[0].rate_pct),
      unitPrice: row.rows[0].unit_price == null ? null : Number(row.rows[0].unit_price)
    };
  }
}

export class MemoryReceiptRepository implements ReceiptRepository {
  private sequence = 1;
  readonly receipts: Array<SavedReceipt & { note: string | null }> = [];

  // conditionLineId → 条件の rate_pct / unit_price（DB読み取り相当）。
  constructor(private readonly conditions = new Map<number, { ratePct: number | null; unitPrice: number | null }>([
    [1, { ratePct: 10, unitPrice: 500 }]
  ])) {}

  async create(conditionLineId: number, input: ReceiptWriteInput) {
    const cond = this.conditions.get(conditionLineId);
    if (!cond) throw new ReceiptReferenceError("condition line not found");
    return this.persist(this.sequence++, conditionLineId, cond, input);
  }

  async update(receiptId: number, input: ReceiptWriteInput) {
    const existing = this.receipts.find((r) => r.id === receiptId);
    if (!existing) throw new ReceiptReferenceError("receipt not found");
    const cond = this.conditions.get(existing.conditionLineId);
    if (!cond) throw new ReceiptReferenceError("condition line not found");
    this.receipts.splice(this.receipts.indexOf(existing), 1);
    return this.persist(receiptId, existing.conditionLineId, cond, input);
  }

  private persist(
    id: number,
    conditionLineId: number,
    cond: ReceiptCondition,
    input: ReceiptWriteInput
  ): SavedReceipt {
    const royalty = computeReceiptRoyalty(
      { calcType: input.calcType ?? null, ratePct: cond.ratePct, unitPrice: cond.unitPrice },
      { reportedSales: input.reportedSales, reportedQuantity: input.reportedQuantity }
    );
    const saved = {
      id,
      conditionLineId,
      period: input.period ?? null,
      computedRoyaltyExTax: royalty,
      receivedAmount: input.receivedAmount ?? null,
      status: statusFor(input.receivedAmount),
      note: input.note ?? null
    };
    this.receipts.push(saved);
    return saved;
  }
}
