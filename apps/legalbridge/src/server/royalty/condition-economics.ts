import { Router } from "express";
import { z } from "zod";
import type { DatabasePool } from "../db/pool.js";

// 条件明細の経済条件＋AG消化累計の読取（V1 getRoyaltyConditionEconomics ＋
// getAgConsumedToDate の移植）。利用許諾料計算書フォームの
// 「条件明細から取得」プリフィルに使う＝料率・MG/AG・AG消化済み累計を
// 手入力させず DB を正とする（監査2026-08-25 ギャップ⚠1/⚠2）。
//   - 加算型（v3・group_no あり）は同一文書・同一 group の全行を1条件として扱い、
//     適用料率 = Σrate_pct、MG/AG/通貨は代表行（最小 line_no）から取る（V1 Stage C-3）。
//   - AG/MG 消化累計はグループ全行の condition_events（void 除外）を SUM。

export interface ConditionEconomics {
  conditionLineId: number;          // 問い合わせた行
  representativeLineId: number;     // 代表行（記帳先に使う）
  conditionName: string | null;
  currency: string;
  ratePct: number;                  // 加算型は Σ
  mgAmount: number;
  agAmount: number;
  agConsumed: number;               // void 除外の累計
  mgConsumed: number;
  eventCount: number;
  agRemaining: number;              // max(0, agAmount - agConsumed)
  groupSize: number;                // 加算型の行数（1=単独）
  // 有効性（2026-09-02）：巻き直しで旧版になった文書（form_data.superseded_by）や
  // 無効化（voided）された文書の条件は計算書の下地にしない。ルートは 409 で止める。
  effective: boolean;
  ineffectiveReason: "superseded" | "voided" | null;
  supersededBy: string | null;      // 旧版のとき有効版の文書番号
}

export interface ConditionEconomicsRepository {
  find(conditionLineId: number): Promise<ConditionEconomics | null>;
}

const num = (v: unknown): number => {
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : 0;
};

export class PgConditionEconomicsRepository implements ConditionEconomicsRepository {
  constructor(private readonly database: DatabasePool) {}

  async find(conditionLineId: number) {
    const base = await this.database.query(
      `SELECT cl.id, cl.document_id, cl.group_no, cl.line_no, cl.rate_pct, cl.mg_amount, cl.ag_amount,
              cl.currency, cl.condition_name,
              d.lifecycle_status, d.form_data->>'superseded_by' AS superseded_by
         FROM condition_lines cl
         LEFT JOIN documents d ON d.id = cl.document_id
        WHERE cl.id = $1`,
      [conditionLineId]
    );
    if (!base.rows[0]) return null;
    const row = base.rows[0];
    const supersededBy = String(row.superseded_by ?? "").trim() || null;
    const voided = String(row.lifecycle_status ?? "") === "voided";
    const ineffectiveReason: ConditionEconomics["ineffectiveReason"] =
      voided ? "voided" : supersededBy ? "superseded" : null;

    // 加算型: 同一文書・同一 group の全セルを1条件として集計。
    let group = [row];
    if (row.group_no != null && row.document_id != null) {
      const cells = await this.database.query(
        `SELECT id, line_no, rate_pct, mg_amount, ag_amount, currency, condition_name
           FROM condition_lines
          WHERE document_id = $1 AND group_no = $2
          ORDER BY line_no, id`,
        [row.document_id, row.group_no]
      );
      if (cells.rows.length) group = cells.rows;
    }
    const representative = group[0];
    const lineIds = group.map((r) => Number(r.id));

    const consumed = await this.database.query(
      `SELECT COALESCE(SUM(ag_consumed_this_time), 0) AS ag,
              COALESCE(SUM(mg_consumed_this_time), 0) AS mg,
              COUNT(*)::int AS n
         FROM condition_events
        WHERE condition_line_id = ANY($1::bigint[]) AND voided_at IS NULL`,
      [lineIds]
    );
    const agAmount = num(representative.ag_amount);
    const agConsumed = num(consumed.rows[0]?.ag);
    return {
      conditionLineId,
      representativeLineId: Number(representative.id),
      conditionName: representative.condition_name == null ? null : String(representative.condition_name),
      currency: String(representative.currency ?? "JPY") || "JPY",
      ratePct: group.reduce((sum, r) => sum + num(r.rate_pct), 0),
      mgAmount: num(representative.mg_amount),
      agAmount,
      agConsumed,
      mgConsumed: num(consumed.rows[0]?.mg),
      eventCount: num(consumed.rows[0]?.n),
      agRemaining: Math.max(0, agAmount - agConsumed),
      groupSize: group.length,
      effective: ineffectiveReason === null,
      ineffectiveReason,
      supersededBy
    };
  }
}

export class MemoryConditionEconomicsRepository implements ConditionEconomicsRepository {
  constructor(private readonly store: Record<number, ConditionEconomics> = {}) {}
  async find(conditionLineId: number) { return this.store[conditionLineId] ?? null; }
}

const idPath = z.object({ id: z.coerce.number().int().positive() });

export function createConditionEconomicsRouter(repository?: ConditionEconomicsRepository) {
  const router = Router();
  router.get("/royalty/condition-economics/:id", async (request, response, next) => {
    try {
      if (!repository) {
        return response.status(503).json({ error: "condition economics is unavailable", code: "CONDITION_ECONOMICS_UNAVAILABLE" });
      }
      const { id } = idPath.parse(request.params);
      const economics = await repository.find(id);
      if (!economics) {
        return response.status(404).json({ error: "条件明細が見つかりません", code: "CONDITION_LINE_NOT_FOUND" });
      }
      // 有効でない条件（巻き直しの旧版・無効化文書）は計算書の下地にしない。
      if (!economics.effective) {
        return response.status(409).json({
          error: economics.ineffectiveReason === "superseded"
            ? `この条件明細は巻き直し済み（旧版）の文書のものです。有効版 ${economics.supersededBy ?? ""} の条件明細を使ってください`.trim()
            : "この条件明細は無効化された文書のものです。計算書の下地にはできません",
          code: "CONDITION_LINE_INEFFECTIVE",
          economics
        });
      }
      return response.status(200).json({ economics });
    } catch (error) {
      if (error instanceof z.ZodError) return response.status(400).json({ error: "invalid request", issues: error.issues });
      return next(error);
    }
  });
  return router;
}
