import type { Queryable } from "../core/db.js";
import { str } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { renderDocumentHtml } from "../documents/render.js";
import {
  buildPaymentReport, REPORT_SOURCE_KEYS, templateValues,
  type PaymentReportBasis, type PaymentReportDocument, type RawDoc
} from "./payment-report-doc.js";
import { PAYMENT_REPORT_TEMPLATE_HTML, PAYMENT_REPORT_TEMPLATE_KEY } from "./payment-report-template.js";

/**
 * 支払報告書（payment_report）の読み込みと描画。組み立ての規則は payment-report-doc.ts。
 *
 * 相手先は文書の相手先（契約・案件・先頭の条件の相手先）。受取人宛ての計算書（共著の取り分。
 * manual_inputs._payeePartyId）はその受取人。未送付の束（unsent-bundles.ts）と同じ決め方。
 * 読むだけで、何も書かない（番号も振らない）。
 */

export interface PaymentReportInput {
  partyId: number; from: string; to: string; basis?: PaymentReportBasis;
  excludeIds?: number[]; remarks?: string | null;
}

const PRINTED_DUE_SQL = `CASE WHEN jsonb_typeof(d.rendered_values) = 'object' THEN COALESCE(
        NULLIF(d.rendered_values->>'PAYMENT_DATE', ''),
        NULLIF(d.rendered_values->>'paymentDueDate', ''),
        NULLIF(d.rendered_values->>'支払期日', ''),
        NULLIF(d.rendered_values->>'summaryPaymentDate', '')) END`;

const isoOrNull = (v: unknown): string | null => {
  const s = str(v)?.slice(0, 10) ?? null;
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};
const n = (v: unknown): number => Number(v ?? 0) || 0;
const nn = (v: unknown): number | null => v === null || v === undefined || v === "" ? null : Number(v);

export class PaymentReportDocService {
  constructor(private readonly database: Queryable) {}

  async build(input: PaymentReportInput): Promise<PaymentReportDocument> {
    if (input.from > input.to) throw new DomainError("VALIDATION", "期間の開始が終了より後になっています");
    try {
      const party = (await this.database.query(
        `SELECT id, name, kind, address, invoice_no FROM parties WHERE id = $1`, [input.partyId])).rows[0];
      if (!party) throw new DomainError("NOT_FOUND", `取引先 ${input.partyId} が見つかりません`);

      const docRows = (await this.database.query(
        `SELECT d.id, d.document_no, t.template_key, t.label AS template_label, v.title,
                (d.issued_at AT TIME ZONE 'Asia/Tokyo')::date::text AS issued_on,
                ${PRINTED_DUE_SQL} AS printed_pay_on,
                d.rendered_values->'delivery_line_items' AS delivery_lines,
                d.rendered_values->'other_fees' AS other_fees,
                d.rendered_values->'expenses' AS expenses,
                d.rendered_values->>'taxableSubtotalExTaxStr' AS subtotal,
                d.rendered_values->>'combinedTaxStr' AS tax,
                d.rendered_values->>'grandTotalPayableStr' AS grand,
                COALESCE(NULLIF(d.rendered_values->>'PERIOD', ''), NULLIF(d.rendered_values->>'pubPeriodLabel', '')) AS period
           FROM documents d
           JOIN v_document_display v ON v.document_id = d.id
           JOIN document_template_versions tv ON tv.id = d.template_version_id
           JOIN document_templates t ON t.id = tv.template_id
          WHERE d.status = 'issued' AND NOT d.inbound
            AND t.template_key = ANY($2::text[])
            AND COALESCE(CASE WHEN d.manual_inputs->>'_payeePartyId' ~ '^[0-9]+$'
                              THEN (d.manual_inputs->>'_payeePartyId')::bigint END,
                         v.counterparty_id) = $1
          ORDER BY d.id`, [input.partyId, REPORT_SOURCE_KEYS])).rows as Array<Record<string, any>>;

      const ids = docRows.map((r) => Number(r.id));
      const docs = new Map<number, RawDoc>();
      for (const r of docRows) {
        docs.set(Number(r.id), {
          id: Number(r.id), documentNo: str(r.document_no), templateKey: str(r.template_key),
          templateLabel: str(r.template_label), title: str(r.title), issuedOn: isoOrNull(r.issued_on),
          printedPayOn: isoOrNull(r.printed_pay_on),
          rendered: { deliveryLines: r.delivery_lines, otherFees: r.other_fees, expenses: r.expenses,
                      subtotal: r.subtotal, tax: r.tax, grand: r.grand, period: r.period },
          statements: [], statementLines: [], events: [], payments: []
        });
      }

      if (ids.length) {
        const statements = (await this.database.query(
          `SELECT s.id, s.document_id, s.period, s.currency, s.net_amount, s.tax_amount
             FROM statements s
            WHERE s.document_id = ANY($1::bigint[])
              AND (s.payee_party_id IS NULL OR s.payee_party_id = $2)
            ORDER BY s.document_id, s.id`, [ids, input.partyId])).rows as Array<Record<string, any>>;
        for (const s of statements) {
          docs.get(Number(s.document_id))?.statements.push({
            id: Number(s.id), period: str(s.period), currency: String(s.currency ?? "JPY"),
            netAmount: n(s.net_amount), taxAmount: n(s.tax_amount)
          });
        }
        const lines = (await this.database.query(
          `SELECT s.document_id, l.statement_id, s.period, l.product_name, l.quantity, l.sample_quantity,
                  l.unit_amount, l.rate_ppm, l.sales_input, l.amount, c.name AS condition_name, c.condition_no
             FROM statement_lines l
             JOIN statements s ON s.id = l.statement_id
             LEFT JOIN conditions c ON c.id = l.condition_id
            WHERE s.document_id = ANY($1::bigint[])
              AND (s.payee_party_id IS NULL OR s.payee_party_id = $2)
            ORDER BY s.document_id, s.id, l.line_no`, [ids, input.partyId])).rows as Array<Record<string, any>>;
        for (const l of lines) {
          docs.get(Number(l.document_id))?.statementLines.push({
            statementId: Number(l.statement_id), period: str(l.period), productName: str(l.product_name),
            quantity: nn(l.quantity), sampleQuantity: nn(l.sample_quantity), unitAmount: nn(l.unit_amount),
            ratePpm: nn(l.rate_ppm), salesInput: nn(l.sales_input), amount: n(l.amount),
            conditionName: str(l.condition_name), conditionNo: str(l.condition_no)
          });
        }
        const events = (await this.database.query(
          `SELECT ev.id, ev.document_id, ev.occurred_on::text AS occurred_on, ev.quantity, ev.amount, ev.period,
                  c.name AS condition_name, c.condition_no, c.currency
             FROM condition_events ev
             JOIN conditions c ON c.id = ev.condition_id
            WHERE ev.status = 'active' AND ev.document_id = ANY($1::bigint[])
            ORDER BY ev.document_id, ev.occurred_on, ev.id`, [ids])).rows as Array<Record<string, any>>;
        for (const e of events) {
          docs.get(Number(e.document_id))?.events.push({
            id: Number(e.id), occurredOn: isoOrNull(e.occurred_on), quantity: nn(e.quantity), amount: n(e.amount),
            period: str(e.period), conditionName: str(e.condition_name), conditionNo: str(e.condition_no),
            currency: str(e.currency)
          });
        }
        // 文書の実績（文書が結ぶ実績と、計算書の明細が指す実績）に割り当てた支払。この相手先への支払だけ。
        const payments = (await this.database.query(
          `WITH de AS (
             SELECT ev.document_id AS doc_id, ev.id AS event_id
               FROM condition_events ev
              WHERE ev.status = 'active' AND ev.document_id = ANY($1::bigint[])
             UNION
             SELECT s.document_id, l.event_id
               FROM statement_lines l JOIN statements s ON s.id = l.statement_id
              WHERE s.document_id = ANY($1::bigint[]) AND l.event_id IS NOT NULL
                AND (s.payee_party_id IS NULL OR s.payee_party_id = $2)
           )
           SELECT de.doc_id, y.id, y.payment_no, y.currency, y.amount, y.tax_amount, y.withholding_amount,
                  y.due_on::text AS due_on, y.paid_on::text AS paid_on, y.status,
                  sum(a.amount) AS allocated,
                  (SELECT sum(a2.amount) FROM payment_allocations a2 WHERE a2.payment_id = y.id) AS allocated_total
             FROM de
             JOIN payment_allocations a ON a.event_id = de.event_id
             JOIN payments y ON y.id = a.payment_id
            WHERE y.status <> 'canceled' AND y.direction = 'out' AND y.party_id = $2
            GROUP BY de.doc_id, y.id
            ORDER BY de.doc_id, y.due_on NULLS LAST, y.id`, [ids, input.partyId])).rows as Array<Record<string, any>>;
        for (const p of payments) {
          docs.get(Number(p.doc_id))?.payments.push({
            id: Number(p.id), paymentNo: str(p.payment_no), currency: String(p.currency ?? "JPY"),
            amount: n(p.amount), taxAmount: n(p.tax_amount), withholdingAmount: n(p.withholding_amount),
            dueOn: isoOrNull(p.due_on), paidOn: isoOrNull(p.paid_on), status: String(p.status),
            allocated: n(p.allocated), allocatedTotal: n(p.allocated_total)
          });
        }
      }

      return buildPaymentReport({
        party: {
          id: Number(party.id), name: String(party.name ?? ""),
          kind: party.kind === "individual" ? "individual" : "corporate",
          address: str(party.address), invoiceNo: str(party.invoice_no)
        },
        from: input.from, to: input.to, basis: input.basis ?? "pay",
        docs: [...docs.values()], excludeIds: input.excludeIds
      });
    } catch (error) { throw translate(error); }
  }

  /** ひな形の本文。DB に登録済み（198）なら現行版、無ければ既定の本文。 */
  async templateSource(): Promise<string> {
    try {
      const r = await this.database.query(
        `SELECT v.html_source FROM document_templates t
           JOIN document_template_versions v ON v.id = t.current_version_id
          WHERE t.template_key = $1 AND t.is_active`, [PAYMENT_REPORT_TEMPLATE_KEY]);
      const html = str((r.rows[0] as { html_source?: unknown } | undefined)?.html_source);
      return html ?? PAYMENT_REPORT_TEMPLATE_HTML;
    } catch {
      return PAYMENT_REPORT_TEMPLATE_HTML;
    }
  }

  async render(input: PaymentReportInput, today: string): Promise<{ html: string; report: PaymentReportDocument }> {
    const report = await this.build(input);
    const company = await this.company();
    const values = templateValues(report, { company, documentDate: today, remarks: input.remarks ?? null });
    return { html: renderDocumentHtml(await this.templateSource(), values), report };
  }

  private async company(): Promise<Record<string, unknown>> {
    try {
      const r = await this.database.query("SELECT value FROM settings WHERE key = 'company_profile'");
      const value = (r.rows[0] as { value?: Record<string, unknown> } | undefined)?.value;
      return (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    } catch { return {}; }
  }
}
