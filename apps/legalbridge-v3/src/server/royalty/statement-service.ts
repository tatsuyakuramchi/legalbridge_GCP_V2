import { inTransaction, type Queryable, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { calculateFee, type FeeResult } from "./calc.js";
import { computeRoyaltyPayment, resolveWithholdingEnabled, type PaymentBreakdown } from "./tax.js";
import {
  buildAdjustments, buildFeeTerms, taxRateFor, toMajor, toMinor,
  type ConditionEconomics, type ReportedResult
} from "./economics.js";

export interface CalculationInput {
  conditionId: number;
  period: string;
  occurredOn?: string | null;
  eventType?: "manufacturing" | "sales" | "sublicense_receipt" | "service_period" | "adjustment";
  reported: ReportedResult;
}

export interface CalculationPreview {
  condition: { id: number; conditionNo: string | null; currency: string; pricingModel: string };
  /** エンジンの結果（主単位）。画面はこれをそのまま表示できる。 */
  fee: FeeResult;
  /** 支払側の内訳。源泉は相手先が個人なら自動で対象になる。 */
  payment: PaymentBreakdown & { withholdingEnabled: boolean };
  /** 保存するときの値（最小通貨単位）。 */
  amounts: { grossMinor: number; netMinor: number; taxMinor: number; agOffsetMinor: number; mgTopupMinor: number };
  agConsumedBefore: number;
}

/**
 * ロイヤリティの試算と確定。
 *
 * 計算そのものは移植したエンジン（calc / tax / fx）が持つ。ここは
 *   1. 条件と消化済みAGを読む
 *   2. 単位を合わせてエンジンを呼ぶ
 *   3. 確定時だけ、実績・計算書・明細・支払を1トランザクションで書く
 * だけを担う。フォームの値は信用せず、確定時に必ず計算し直す（V1・V2 と同じ防御）。
 */
export class RoyaltyStatementService {
  constructor(private readonly database: Transactable) {}

  async preview(input: CalculationInput): Promise<CalculationPreview> {
    try {
      return await this.calculate(this.database, input);
    } catch (error) { throw translate(error); }
  }

  /**
   * 確定。実績イベントを1件立て、計算書と明細を作る。
   * documentId を渡すと発行済み文書に結びつける（計算書＝文書）。
   */
  async finalize(
    input: CalculationInput & { documentId: number },
    actor: string
  ): Promise<{ statementId: number; eventId: number; netMinor: number }> {
    try {
      return await inTransaction(this.database, async (client) => {
        const document = await client.query(
          "SELECT id, status FROM documents WHERE id = $1 FOR UPDATE", [input.documentId]);
        const documentRow = document.rows[0] as { status?: string } | undefined;
        if (!documentRow) throw new DomainError("NOT_FOUND", `文書 ${input.documentId} が見つかりません`);
        if (documentRow.status !== "issued") {
          throw new DomainError("CONFLICT", "発行済みの文書にだけ計算書を結び付けられます");
        }
        const already = await client.query(
          "SELECT id FROM statements WHERE document_id = $1", [input.documentId]);
        if (already.rows[0]) {
          throw new DomainError("CONFLICT", "この文書にはすでに計算書があります");
        }

        // 画面から来た金額は使わず、ここで計算し直す。
        const result = await this.calculate(client, input);

        const event = await client.query(
          `INSERT INTO condition_events
             (condition_id, event_type, occurred_on, period, quantity, sample_quantity,
              gross_amount, deductions, amount, document_id, created_by)
           VALUES ($1, $2, COALESCE($3::date, current_date), $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING id`,
          [input.conditionId, input.eventType ?? "sales", input.occurredOn ?? null, input.period,
           input.reported.quantity ?? null, input.reported.sampleQuantity ?? null,
           result.amounts.grossMinor, result.amounts.agOffsetMinor, result.amounts.netMinor,
           input.documentId, actor]
        );
        const eventId = Number((event.rows[0] as { id: number }).id);

        const statement = await client.query(
          `INSERT INTO statements
             (document_id, condition_id, period, currency, gross_amount, mg_topup, ag_offset,
              net_amount, tax_amount)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id`,
          [input.documentId, input.conditionId, input.period, result.condition.currency,
           result.amounts.grossMinor, result.amounts.mgTopupMinor, result.amounts.agOffsetMinor,
           result.amounts.netMinor, result.amounts.taxMinor]
        );
        const statementId = Number((statement.rows[0] as { id: number }).id);

        await client.query(
          `INSERT INTO statement_lines
             (statement_id, line_no, condition_id, event_id, quantity, sample_quantity,
              unit_amount, rate_ppm, sales_input, fx_rate, amount)
           VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [statementId, input.conditionId, eventId,
           input.reported.quantity ?? null, input.reported.sampleQuantity ?? null,
           null, null, input.reported.salesInput ?? null, input.reported.fxRate ?? null,
           result.amounts.netMinor]
        );

        await recordAudit(client, {
          actor, action: "royalty.finalize", targetType: "statement", targetId: statementId,
          detail: {
            conditionId: input.conditionId, documentId: input.documentId, period: input.period,
            gross: result.amounts.grossMinor, net: result.amounts.netMinor,
            agOffset: result.amounts.agOffsetMinor, mgTopup: result.amounts.mgTopupMinor,
            formula: result.fee.formula_breakdown
          }
        });

        return { statementId, eventId, netMinor: result.amounts.netMinor };
      });
    } catch (error) { throw translate(error); }
  }

  /** 計算書の一覧。文書と条件を添えて返す。 */
  async list(query: { conditionId?: number; limit?: number } = {}) {
    const params: unknown[] = [];
    const where: string[] = [];
    if (query.conditionId) { params.push(query.conditionId); where.push(`s.condition_id = $${params.length}`); }
    params.push(Math.min(Math.max(query.limit ?? 200, 1), 500));
    try {
      const r = await this.database.query(
        `SELECT s.id, s.period, s.currency, s.gross_amount, s.mg_topup, s.ag_offset,
                s.net_amount, s.tax_amount,
                d.id AS document_id, d.document_no, c.condition_no, c.name AS condition_name,
                p.name AS counterparty
           FROM statements s
           JOIN documents d  ON d.id = s.document_id
           JOIN conditions c ON c.id = s.condition_id
           LEFT JOIN parties p ON p.id = c.counterparty_id
          ${where.length ? "WHERE " + where.join(" AND ") : ""}
          ORDER BY s.id DESC
          LIMIT $${params.length}`, params);
      return r.rows.map((row: Record<string, any>) => ({
        id: Number(row.id),
        period: String(row.period),
        currency: String(row.currency),
        grossAmount: Number(row.gross_amount),
        mgTopup: Number(row.mg_topup),
        agOffset: Number(row.ag_offset),
        netAmount: Number(row.net_amount),
        taxAmount: Number(row.tax_amount),
        documentId: Number(row.document_id),
        documentNo: row.document_no ? String(row.document_no) : null,
        conditionNo: row.condition_no ? String(row.condition_no) : null,
        conditionName: String(row.condition_name),
        counterparty: row.counterparty ? String(row.counterparty) : null
      }));
    } catch (error) { throw translate(error); }
  }

  private async calculate(client: Queryable, input: CalculationInput): Promise<CalculationPreview> {
    const condition = await this.loadCondition(client, input.conditionId);
    const agConsumedBefore = await this.agConsumedBefore(client, input.conditionId);

    const terms = buildFeeTerms(condition, input.reported);
    const adjustments = buildAdjustments(condition, input.reported, agConsumedBefore);
    const fee = calculateFee(terms, adjustments, taxRateFor(condition));

    const withholdingEnabled = resolveWithholdingEnabled({
      vendorWithholdingEnabled: condition.counterpartyWithholding,
      entityType: condition.counterpartyKind
    });
    const payment = computeRoyaltyPayment({
      subtotalExTax: fee.actual_ex_tax,
      taxRatePct: taxRateFor(condition),
      withholdingEnabled
    });

    const currency = condition.currency;
    return {
      condition: {
        id: condition.id, conditionNo: condition.conditionNo,
        currency, pricingModel: condition.pricingModel
      },
      fee,
      payment: { ...payment, withholdingEnabled },
      amounts: {
        grossMinor: toMinor(fee.gross_ex_tax, currency),
        netMinor: toMinor(fee.actual_ex_tax, currency),
        taxMinor: toMinor(fee.tax_amount, currency),
        agOffsetMinor: toMinor(fee.ag_offset_this_time, currency),
        mgTopupMinor: toMinor(fee.mg_topup_this_time, currency)
      },
      agConsumedBefore
    };
  }

  private async loadCondition(client: Queryable, id: number) {
    const r = await client.query(
      `SELECT c.id, c.condition_no, c.currency, c.pricing_model, c.rate_ppm,
              c.unit_amount, c.flat_amount, c.mg_amount, c.ag_amount, c.tax_category, c.status,
              p.withholding, p.kind AS party_kind
         FROM conditions c LEFT JOIN parties p ON p.id = c.counterparty_id
        WHERE c.id = $1`, [id]);
    const row = r.rows[0] as Record<string, any> | undefined;
    if (!row) throw new DomainError("NOT_FOUND", `条件 ${id} が見つかりません`);
    if (row.status === "void" || row.status === "superseded") {
      throw new DomainError("CONFLICT", "無効または旧版の条件では計算できません");
    }
    return {
      id: Number(row.id),
      conditionNo: row.condition_no ? String(row.condition_no) : null,
      currency: String(row.currency ?? "JPY"),
      pricingModel: String(row.pricing_model) as ConditionEconomics["pricingModel"],
      ratePpm: row.rate_ppm === null ? null : Number(row.rate_ppm),
      unitAmount: row.unit_amount === null ? null : Number(row.unit_amount),
      flatAmount: row.flat_amount === null ? null : Number(row.flat_amount),
      mgAmount: row.mg_amount === null ? null : Number(row.mg_amount),
      agAmount: row.ag_amount === null ? null : Number(row.ag_amount),
      taxCategory: String(row.tax_category ?? "taxable") as ConditionEconomics["taxCategory"],
      counterpartyWithholding: row.withholding === true,
      counterpartyKind: row.party_kind ? String(row.party_kind) : null
    };
  }

  /**
   * これまでに消化した AG の累計（最小通貨単位）。
   * void のイベントは数えない。deductions 列に AG 相殺分を積んでいる。
   */
  private async agConsumedBefore(client: Queryable, conditionId: number): Promise<number> {
    const r = await client.query(
      `SELECT COALESCE(SUM(deductions), 0)::bigint AS consumed
         FROM condition_events
        WHERE condition_id = $1 AND status = 'active'`, [conditionId]);
    return Number((r.rows[0] as { consumed: string | number }).consumed ?? 0);
  }
}
