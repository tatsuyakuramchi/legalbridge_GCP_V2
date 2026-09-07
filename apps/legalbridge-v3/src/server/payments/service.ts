import { inTransaction, type Queryable, type Transactable } from "../core/db.js";
import { dateStr, str } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { checkPaymentDue, dueLimitFrom, isFreelanceActTarget, type DueCheck } from "./compliance.js";
import { consumptionTax, resolveWithholdingEnabled, withholdingTax } from "../royalty/tax.js";
import { taxRateFor } from "../royalty/economics.js";

export interface PaymentRow {
  id: number;
  paymentNo: string | null;
  direction: "in" | "out";
  party: { id: number; name: string; kind: string } | null;
  currency: string;
  amount: number;
  taxAmount: number;
  withholdingAmount: number;
  basisReceivedOn: string | null;
  dueOn: string | null;
  paidOn: string | null;
  status: string;
  allocations: Array<{ conditionId: number; conditionNo: string | null; eventId: number | null; amount: number }>;
  due: DueCheck;
}

/**
 * 支払。条件と実績への割当を必ず持たせる。
 * V2 には割当の表が無く、根拠のない支払行（レガシーの royalty_payments）が
 * 残っていたので、V3 では割当なしで作れないようにする。
 */
export class PaymentService {
  constructor(private readonly database: Transactable) {}

  /** 計算書から支払を起こす。金額は計算書の値をそのまま使う（再計算済みのため）。 */
  async createFromStatement(statementId: number, actor: string, options: { dueOn?: string | null } = {}) {
    try {
      return await inTransaction(this.database, async (client) => {
        const head = await client.query(
          `SELECT s.id, s.condition_id, s.currency, s.net_amount, s.tax_amount, s.period,
                  c.direction, c.tax_category, c.counterparty_id,
                  p.kind AS party_kind, p.withholding, p.name AS party_name,
                  e.id AS event_id, e.occurred_on
             FROM statements s
             JOIN conditions c ON c.id = s.condition_id
             LEFT JOIN parties p ON p.id = c.counterparty_id
             LEFT JOIN LATERAL (
               SELECT id, occurred_on FROM condition_events
                WHERE condition_id = s.condition_id AND document_id = s.document_id
                  AND status = 'active'
                ORDER BY id DESC LIMIT 1
             ) e ON true
            WHERE s.id = $1
            FOR UPDATE OF s`, [statementId]);
        const row = head.rows[0] as Record<string, any> | undefined;
        if (!row) throw new DomainError("NOT_FOUND", `計算書 ${statementId} が見つかりません`);
        if (!row.counterparty_id) {
          throw new DomainError("VALIDATION", "相手先が未設定の条件からは支払を作れません");
        }

        const duplicated = await client.query(
          `SELECT p.id FROM payments p
             JOIN payment_allocations a ON a.payment_id = p.id
            WHERE a.condition_id = $1 AND a.event_id IS NOT DISTINCT FROM $2
              AND p.status <> 'canceled'`,
          [row.condition_id, row.event_id ?? null]);
        if (duplicated.rows[0]) {
          throw new DomainError("CONFLICT",
            `この実績にはすでに支払 #${(duplicated.rows[0] as { id: number }).id} があります`);
        }

        // 権利を許諾する側（out）は受け取る側なので入金、取得側（in）は支払。
        const direction: "in" | "out" = row.direction === "out" ? "in" : "out";
        const currency = String(row.currency ?? "JPY");
        const net = Number(row.net_amount ?? 0);
        const taxRate = taxRateFor({
          id: 0, conditionNo: null, currency, pricingModel: "none",
          ratePpm: null, unitAmount: null, flatAmount: null, mgAmount: null, agAmount: null,
          taxCategory: String(row.tax_category ?? "taxable") as "taxable" | "reduced" | "exempt"
        });
        const tax = Number(row.tax_amount ?? consumptionTax(net, taxRate));

        // 源泉は自社が支払う側でだけ差し引く。
        const withholdingEnabled = direction === "out" && resolveWithholdingEnabled({
          vendorWithholdingEnabled: row.withholding === true,
          entityType: str(row.party_kind)
        });
        const withholding = withholdingEnabled ? withholdingTax(net + tax, true) : 0;

        const basis = dateStr(row.occurred_on);
        const dueOn = options.dueOn ?? dueLimitFrom(basis);

        const inserted = await client.query(
          `INSERT INTO payments
             (direction, party_id, currency, amount, tax_amount, withholding_amount,
              basis_received_on, due_on, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8::date, 'planned')
           RETURNING id`,
          [direction, row.counterparty_id, currency, net, tax, withholding, basis, dueOn]);
        const paymentId = Number((inserted.rows[0] as { id: number }).id);

        await client.query(
          `INSERT INTO payment_allocations (payment_id, condition_id, event_id, amount)
           VALUES ($1, $2, $3, $4)`,
          [paymentId, row.condition_id, row.event_id ?? null, net]);

        const due = checkPaymentDue({
          applicable: direction === "out" && isFreelanceActTarget(str(row.party_kind)),
          basisDate: basis, dueOn
        });

        await recordAudit(client, {
          actor, action: "payment.create", targetType: "payment", targetId: paymentId,
          detail: {
            statementId, conditionId: row.condition_id, direction,
            amount: net, tax, withholding, basis, dueOn, dueVerdict: due.verdict
          }
        });
        // 期日が上限を超えていたら、記録として残して一覧で拾えるようにする。
        if (due.verdict === "over_limit") {
          await client.query(
            `INSERT INTO data_quality_issues (rule_code, target_type, target_id, severity, detail)
             VALUES ('PAYMENT_DUE_OVER_LIMIT', 'payment', $1, 'high', $2::jsonb)
             ON CONFLICT (rule_code, target_type, target_id) DO UPDATE
               SET detail = EXCLUDED.detail, detected_at = now(), status = 'open'`,
            [paymentId, JSON.stringify({ basis, dueOn, overBy: due.overBy, limitDate: due.limitDate })]);
        }

        return { paymentId, direction, amount: net, tax, withholding, dueOn, due };
      });
    } catch (error) { throw translate(error); }
  }

  /** 支払の記録（実際に振り込んだ日を入れる）。 */
  async markPaid(paymentId: number, paidOn: string, actor: string) {
    try {
      return await inTransaction(this.database, async (client) => {
        const updated = await client.query(
          `UPDATE payments SET status = 'paid', paid_on = $2::date, updated_at = now()
            WHERE id = $1 AND status <> 'canceled'
            RETURNING id, due_on, basis_received_on`,
          [paymentId, paidOn]);
        const row = updated.rows[0] as Record<string, any> | undefined;
        if (!row) throw new DomainError("NOT_FOUND", `支払 ${paymentId} が見つかりません`);
        await recordAudit(client, {
          actor, action: "payment.paid", targetType: "payment", targetId: paymentId,
          detail: { paidOn, dueOn: dateStr(row.due_on) }
        });
        // 期日までに払えたら、期日超過の記録を閉じる。
        await client.query(
          `UPDATE data_quality_issues SET status = 'resolved', resolved_at = now()
            WHERE rule_code = 'PAYMENT_DUE_OVER_LIMIT' AND target_type = 'payment' AND target_id = $1`,
          [paymentId]);
        return { paymentId, paidOn };
      });
    } catch (error) { throw translate(error); }
  }

  async list(query: { status?: string; direction?: "in" | "out"; limit?: number } = {}): Promise<PaymentRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.status) { params.push(query.status); where.push(`p.status = $${params.length}`); }
    if (query.direction) { params.push(query.direction); where.push(`p.direction = $${params.length}`); }
    params.push(Math.min(Math.max(query.limit ?? 200, 1), 500));
    try {
      const r = await this.database.query(
        `SELECT p.id, p.payment_no, p.direction, p.currency, p.amount, p.tax_amount,
                p.withholding_amount, p.basis_received_on, p.due_on, p.paid_on, p.status,
                pt.id AS party_id, pt.name AS party_name, pt.kind AS party_kind,
                COALESCE(a.allocations, '[]'::jsonb) AS allocations
           FROM payments p
           LEFT JOIN parties pt ON pt.id = p.party_id
           LEFT JOIN LATERAL (
             SELECT jsonb_agg(jsonb_build_object(
                      'conditionId', al.condition_id, 'conditionNo', c.condition_no,
                      'eventId', al.event_id, 'amount', al.amount)) AS allocations
               FROM payment_allocations al
               JOIN conditions c ON c.id = al.condition_id
              WHERE al.payment_id = p.id
           ) a ON true
          ${where.length ? "WHERE " + where.join(" AND ") : ""}
          ORDER BY p.due_on NULLS LAST, p.id DESC
          LIMIT $${params.length}`, params);
      return r.rows.map((row: Record<string, any>) => {
        const basis = dateStr(row.basis_received_on);
        const dueOn = dateStr(row.due_on);
        return {
          id: Number(row.id),
          paymentNo: str(row.payment_no),
          direction: row.direction as "in" | "out",
          party: row.party_id
            ? { id: Number(row.party_id), name: String(row.party_name ?? ""), kind: String(row.party_kind ?? "") }
            : null,
          currency: String(row.currency ?? "JPY"),
          amount: Number(row.amount ?? 0),
          taxAmount: Number(row.tax_amount ?? 0),
          withholdingAmount: Number(row.withholding_amount ?? 0),
          basisReceivedOn: basis,
          dueOn, paidOn: dateStr(row.paid_on),
          status: String(row.status),
          allocations: (row.allocations as PaymentRow["allocations"]) ?? [],
          due: checkPaymentDue({
            applicable: row.direction === "out" && isFreelanceActTarget(str(row.party_kind)),
            basisDate: basis, dueOn
          })
        };
      });
    } catch (error) { throw translate(error); }
  }
}
