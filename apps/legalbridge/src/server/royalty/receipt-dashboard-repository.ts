import type { DatabasePool } from "../db/pool.js";

// 請求ダッシュボード（再許諾料 受領・分配の横断一覧）の読み取り。
// V1 `GET /api/v3/receipts-dashboard`（workModel.ts）を V2 の condition_lines
// モデルへ移植。read-only。金銭テーブル未付与（grant 015 未適用）や権限不足
// （42501）では空で安全に縮退する。3KPI（受領再許諾料/実受領/分配）を集計。

export interface ReceiptDashboardRow {
  id: number;
  conditionLineId: number;
  period: string | null;
  workCode: string | null;
  workTitle: string | null;
  counterpartyName: string | null;
  conditionName: string | null;
  reportedSales: number | null;
  computedRoyaltyExTax: number | null;
  receivedAmount: number | null;
  computedDistributionExTax: number | null;
  hasParentLicense: boolean;
  received: boolean;
  distributed: boolean;
}

export interface ReceiptDashboardSummary {
  totalReceiptRoyalty: number;
  totalReceived: number;
  totalDistribution: number;
  count: number;
  truncated: boolean; // 上限件数に達したか
}

export interface ReceiptDashboardQuery {
  q?: string;
  period?: string;
  unreceived?: boolean;
  undistributed?: boolean;
  limit?: number;
}

export interface ReceiptDashboardResult {
  rows: ReceiptDashboardRow[];
  summary: ReceiptDashboardSummary;
}

export interface ReceiptDashboardRepository {
  list(query: ReceiptDashboardQuery): Promise<ReceiptDashboardResult>;
}

const MAX_LIMIT = 1000;

function num(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// 返却済み行（≤上限）を集計する。V1同様、クライアント側合算に相当する導出。
export function summarize(rows: ReceiptDashboardRow[], limit: number): ReceiptDashboardSummary {
  return {
    totalReceiptRoyalty: rows.reduce((s, r) => s + (r.computedRoyaltyExTax ?? 0), 0),
    totalReceived: rows.reduce((s, r) => s + (r.receivedAmount ?? 0), 0),
    totalDistribution: rows.reduce((s, r) => s + (r.computedDistributionExTax ?? 0), 0),
    count: rows.length,
    truncated: rows.length >= limit
  };
}

export class PgReceiptDashboardRepository implements ReceiptDashboardRepository {
  constructor(private readonly database: DatabasePool) {}

  async list(query: ReceiptDashboardQuery): Promise<ReceiptDashboardResult> {
    const limit = Math.min(query.limit ?? MAX_LIMIT, MAX_LIMIT);
    const params: unknown[] = [];
    const where: string[] = [];
    if (query.period) {
      params.push(query.period);
      where.push(`cr.period = $${params.length}`);
    }
    if (query.q) {
      params.push(`%${query.q}%`);
      const p = `$${params.length}`;
      where.push(`(w.title ILIKE ${p} OR w.work_code ILIKE ${p} OR v.vendor_name ILIKE ${p})`);
    }
    if (query.unreceived) where.push("cr.received_amount IS NULL");
    if (query.undistributed) where.push("cr.distribution_payment_id IS NULL");
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    params.push(limit);

    try {
      const result = await this.database.query(
        `SELECT cr.id, cr.condition_line_id, cr.period, cr.reported_sales, cr.computed_royalty_ex_tax,
                cr.received_amount, cr.computed_distribution_ex_tax,
                (cr.received_amount IS NOT NULL) AS received,
                (cr.distribution_payment_id IS NOT NULL) AS distributed,
                cl.condition_name, cl.parent_license_condition_id,
                w.work_code, w.title AS work_title,
                v.vendor_name AS counterparty_name
           FROM condition_receipts cr
           JOIN condition_lines cl ON cl.id = cr.condition_line_id
           LEFT JOIN works w ON w.id = cl.source_work_id
           LEFT JOIN vendors v ON v.id = cl.counterparty_vendor_id
           ${whereSql}
          ORDER BY cr.period_date DESC NULLS LAST, cr.id DESC
          LIMIT $${params.length}`,
        params
      );
      const rows: ReceiptDashboardRow[] = result.rows.map((row) => ({
        id: Number(row.id),
        conditionLineId: Number(row.condition_line_id),
        period: row.period ?? null,
        workCode: row.work_code ?? null,
        workTitle: row.work_title ?? null,
        counterpartyName: row.counterparty_name ?? null,
        conditionName: row.condition_name ?? null,
        reportedSales: num(row.reported_sales),
        computedRoyaltyExTax: num(row.computed_royalty_ex_tax),
        receivedAmount: num(row.received_amount),
        computedDistributionExTax: num(row.computed_distribution_ex_tax),
        hasParentLicense: row.parent_license_condition_id != null,
        received: Boolean(row.received),
        distributed: Boolean(row.distributed)
      }));
      return { rows, summary: summarize(rows, limit) };
    } catch (error) {
      // 権限不足・テーブル未整備は空で縮退（ダッシュボードは描画継続）。
      const code = (error as { code?: string })?.code;
      if (code === "42501" || code === "42P01" || code === "42703") {
        return { rows: [], summary: summarize([], limit) };
      }
      throw error;
    }
  }
}

export class MemoryReceiptDashboardRepository implements ReceiptDashboardRepository {
  constructor(private readonly rows: ReceiptDashboardRow[] = []) {}

  async list(query: ReceiptDashboardQuery): Promise<ReceiptDashboardResult> {
    const limit = Math.min(query.limit ?? MAX_LIMIT, MAX_LIMIT);
    const q = query.q?.trim().toLowerCase();
    const filtered = this.rows.filter((row) => {
      if (query.period && row.period !== query.period) return false;
      if (query.unreceived && row.received) return false;
      if (query.undistributed && row.distributed) return false;
      if (q) {
        const hay = `${row.workTitle ?? ""} ${row.workCode ?? ""} ${row.counterpartyName ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    }).slice(0, limit);
    return { rows: filtered, summary: summarize(filtered, limit) };
  }
}
