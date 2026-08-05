import type { DatabasePool } from "../db/pool.js";
import { computeReceiptRoyalty, resolveDistribution } from "./receipt.js";

// 再許諾料の受領記録（condition_receipts）の作成・更新。
// V1 workModel.ts の受領CRUD／applyDistribution に倣う。
//   - 受領再許諾料（computed_royalty_ex_tax）はサーバが condition_lines の
//     rate_pct / unit_price（DB由来）＋リクエストの calcType / 報告値から再計算。
//   - 上流分配（computed_distribution_ex_tax）は親ライセンスイン条件
//     （condition_lines.parent_license_condition_id → 親の rate_pct）を引き、
//     基準額 × 個数 × 親料率で算定。親料率が引けなければ分配は null で縮退。
// スキーマ（0042 + 0101 + 0115）：condition_line_id が正準FK。
// DELETE は行わない。payments 台帳同期は別スライス（要 grant 016）。

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
  // 分配の基準額・個数の手動上書き（未指定はスマート既定）。
  distributionBase?: number | null;
  distributionQty?: number | null;
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
}

export interface ReceiptRepository {
  create(conditionLineId: number, input: ReceiptWriteInput): Promise<SavedReceipt>;
  update(receiptId: number, input: ReceiptWriteInput): Promise<SavedReceipt>;
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
};

// 受領再許諾料と分配を条件の料率から算定する（純関数の合成）。
function computeValues(cond: ConditionTerms, input: ReceiptWriteInput) {
  const terms = { calcType: input.calcType ?? null, ratePct: cond.ratePct, unitPrice: cond.unitPrice };
  const report = { reportedSales: input.reportedSales, reportedQuantity: input.reportedQuantity };
  const royalty = computeReceiptRoyalty(terms, report);
  const dist = resolveDistribution({
    cond: terms,
    report,
    computedRoyaltyExTax: royalty,
    receivedAmount: input.receivedAmount,
    parentRatePct: cond.parentRatePct,
    baseOverride: input.distributionBase,
    qtyOverride: input.distributionQty
  });
  return { royalty, dist };
}

export class PgReceiptRepository implements ReceiptRepository {
  constructor(private readonly database: DatabasePool) {}

  async create(conditionLineId: number, input: ReceiptWriteInput) {
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
      await client.query("COMMIT");
      return this.saved(Number(inserted.rows[0].id), conditionLineId, input, royalty, dist, status);
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
      await client.query("COMMIT");
      return this.saved(receiptId, conditionLineId, input, royalty, dist, status);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private saved(
    id: number,
    conditionLineId: number,
    input: ReceiptWriteInput,
    royalty: number,
    dist: { base: number; qty: number; distribution: number | null },
    status: "reported" | "received"
  ): SavedReceipt {
    return {
      id,
      conditionLineId,
      period: input.period ?? null,
      computedRoyaltyExTax: royalty,
      receivedAmount: input.receivedAmount ?? null,
      status,
      computedDistributionExTax: dist.distribution,
      distributionBase: dist.base,
      distributionQty: dist.qty
    };
  }

  private async readTerms(
    client: { query: (text: string, params: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
    conditionLineId: number
  ): Promise<ConditionTerms> {
    const row = await client.query(
      "SELECT rate_pct, unit_price, parent_license_condition_id FROM condition_lines WHERE id = $1",
      [conditionLineId]
    );
    if (!row.rows[0]) throw new ReceiptReferenceError("condition line not found");
    const parentId = row.rows[0].parent_license_condition_id == null
      ? null : Number(row.rows[0].parent_license_condition_id);
    let parentRate: number | null = null;
    if (parentId != null) {
      // 親料率が引けなければ分配は null で縮退（id対応の不確実性に対する防御）。
      const parent = await client.query(
        "SELECT rate_pct FROM condition_lines WHERE id = $1",
        [parentId]
      );
      parentRate = parent.rows[0]?.rate_pct == null ? null : Number(parent.rows[0].rate_pct);
    }
    return {
      ratePct: row.rows[0].rate_pct == null ? null : Number(row.rows[0].rate_pct),
      unitPrice: row.rows[0].unit_price == null ? null : Number(row.rows[0].unit_price),
      parentLicenseConditionId: parentId,
      parentRatePct: parentRate
    };
  }
}

export class MemoryReceiptRepository implements ReceiptRepository {
  private sequence = 1;
  readonly receipts: Array<SavedReceipt & { note: string | null }> = [];

  // conditionLineId → 条件の料率/単価/親料率（DB読み取り相当）。
  constructor(private readonly conditions = new Map<number, ConditionTerms>([
    [1, { ratePct: 10, unitPrice: 500, parentLicenseConditionId: null, parentRatePct: null }]
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

  private persist(id: number, conditionLineId: number, cond: ConditionTerms, input: ReceiptWriteInput): SavedReceipt {
    const { royalty, dist } = computeValues(cond, input);
    const saved = {
      id,
      conditionLineId,
      period: input.period ?? null,
      computedRoyaltyExTax: royalty,
      receivedAmount: input.receivedAmount ?? null,
      status: statusFor(input.receivedAmount),
      computedDistributionExTax: dist.distribution,
      distributionBase: dist.base,
      distributionQty: dist.qty,
      note: input.note ?? null
    };
    this.receipts.push(saved);
    return saved;
  }
}
