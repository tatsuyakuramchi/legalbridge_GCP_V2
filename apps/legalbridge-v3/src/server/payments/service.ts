import { inTransaction, type Queryable, type Transactable } from "../core/db.js";
import { dateStr, str } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { checkPaymentDue, dueLimitFrom, isFreelanceActTarget, type DueCheck } from "./compliance.js";
import { consumptionTax, resolveWithholdingEnabled, withholdingTax } from "../royalty/tax.js";
import { taxRateFor } from "../royalty/economics.js";
import { allocateNumber } from "../core/numbering.js";

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

  /**
   * 支払を直に起こす。計算書を伴わない費用（顧問料・実費など）向け。
   *
   * 期日は取適法の検査を通す。受領日から60日を超える期日は、相手先が
   * 特定受託事業者（個人）なら止める。法人相手なら社内基準としての警告に
   * とどめ、記録だけ残す。
   */
  async create(input: {
    partyId: number;
    direction: "in" | "out";
    amount: number;
    currency?: string;
    taxAmount?: number;
    withholdingAmount?: number;
    basisReceivedOn?: string | null;
    dueOn?: string | null;
    note?: string | null;
  }, actor: string) {
    if (!Number.isFinite(input.amount) || input.amount < 0) {
      throw new DomainError("VALIDATION", "金額は0以上の整数（最小通貨単位）です");
    }
    try {
      return await inTransaction(this.database, async (client) => {
        const party = await client.query(
          "SELECT id, name, kind FROM parties WHERE id = $1", [input.partyId]);
        const p = party.rows[0] as { id: number; name: string; kind: string } | undefined;
        if (!p) throw new DomainError("NOT_FOUND", `取引先 ${input.partyId} が見つかりません`);

        // 取適法。個人＝特定受託事業者として扱う。
        const check = checkPaymentDue({
          applicable: input.direction === "out" && p.kind === "individual",
          basisDate: input.basisReceivedOn ?? null,
          dueOn: input.dueOn ?? null
        });
        if (check.verdict === "over_limit") {
          throw new DomainError(
            "VALIDATION",
            `支払期日が受領日から ${check.days} 日後です。60日以内（${check.limitDate} まで）にしてください`,
            { check });
        }

        const no = await allocateNumber(client, { prefix: "PAY", table: "payments", column: "payment_no" });
        const inserted = await client.query(
          `INSERT INTO payments (payment_no, direction, party_id, currency, amount,
                                 tax_amount, withholding_amount,
                                 basis_received_on, due_on, status, note)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'planned', $10)
           RETURNING id, payment_no`,
          [no, input.direction, input.partyId, input.currency ?? "JPY",
           Math.round(input.amount), Math.round(input.taxAmount ?? 0),
           Math.round(input.withholdingAmount ?? 0),
           input.basisReceivedOn ?? null, input.dueOn ?? null, input.note ?? null]);
        const row = inserted.rows[0] as { id: number; payment_no: string };
        const id = Number(row.id);

        await recordAudit(client, {
          actor, action: "payment.create", targetType: "payment", targetId: id,
          detail: { paymentNo: row.payment_no, party: p.name, amount: input.amount,
                    dueOn: input.dueOn ?? null, compliance: check.verdict }
        });
        return { id, paymentNo: row.payment_no, compliance: check };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 支払1件と、その割当を書く。
   *
   * 計算書からも検収書からも同じ手順を踏む（期日の検査 → 記録 → 上限超えの控え）。
   * 入口ごとに書いていたころは、片方だけ直して食い違う余地があった。
   * 支払は必ず割当を持つ。根拠のない支払行を残さないための約束。
   */
  private async writeWithAllocations(
    client: Queryable,
    input: {
      direction: "in" | "out";
      partyId: number;
      partyKind: string | null;
      currency: string;
      net: number;
      tax: number;
      withholding: number;
      basis: string | null;
      dueOn: string | null;
      allocations: Array<{ conditionId: number; eventId: number | null; amount: number }>;
      /** 監査に添える出どころ（計算書 id・文書 id など）。 */
      detail: Record<string, unknown>;
    },
    actor: string
  ) {
    const inserted = await client.query(
      `INSERT INTO payments
         (direction, party_id, currency, amount, tax_amount, withholding_amount,
          basis_received_on, due_on, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8::date, 'planned')
       RETURNING id`,
      [input.direction, input.partyId, input.currency, input.net, input.tax,
       input.withholding, input.basis, input.dueOn]);
    const paymentId = Number((inserted.rows[0] as { id: number }).id);

    for (const a of input.allocations) {
      await client.query(
        `INSERT INTO payment_allocations (payment_id, condition_id, event_id, amount)
         VALUES ($1, $2, $3, $4)`,
        [paymentId, a.conditionId, a.eventId, a.amount]);
    }

    const due = checkPaymentDue({
      applicable: input.direction === "out" && isFreelanceActTarget(input.partyKind),
      basisDate: input.basis, dueOn: input.dueOn
    });

    await recordAudit(client, {
      actor, action: "payment.create", targetType: "payment", targetId: paymentId,
      detail: {
        ...input.detail, direction: input.direction,
        amount: input.net, tax: input.tax, withholding: input.withholding,
        basis: input.basis, dueOn: input.dueOn, dueVerdict: due.verdict
      }
    });
    // 期日が上限を超えていたら、記録として残して一覧で拾えるようにする。
    if (due.verdict === "over_limit") {
      await client.query(
        `INSERT INTO data_quality_issues (rule_code, target_type, target_id, severity, detail)
         VALUES ('PAYMENT_DUE_OVER_LIMIT', 'payment', $1, 'high', $2::jsonb)
         ON CONFLICT (rule_code, target_type, target_id) DO UPDATE
           SET detail = EXCLUDED.detail, detected_at = now(), status = 'open'`,
        [paymentId, JSON.stringify({
          basis: input.basis, dueOn: input.dueOn,
          overBy: due.overBy, limitDate: due.limitDate })]);
    }

    return {
      paymentId, direction: input.direction, amount: input.net,
      tax: input.tax, withholding: input.withholding, dueOn: input.dueOn, due
    };
  }

  /**
   * 計算書（1枚）から支払を立てる。
   *
   * 束ねた計算書は1枚に条件のぶんだけ計算書行が並ぶ。条件ごとに支払を立てると、
   * 相手先には1枚しか出していないのに支払が何件も並び、経理提出用の表も
   * 行がばらける。支払は文書1枚につき1件にし、条件ごとに割当を作る。
   * 割当がそのまま経理の「支払内容」になる。
   */
  async createFromStatementDocument(
    documentId: number, actor: string, options: { dueOn?: string | null } = {}
  ) {
    try {
      return await inTransaction(this.database, async (client) => {
        const found = await client.query(
          `SELECT s.id AS statement_id, s.condition_id, s.currency, s.net_amount, s.tax_amount,
                  c.direction, c.tax_category, c.counterparty_id,
                  p.kind AS party_kind, p.withholding,
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
            WHERE s.document_id = $1
            ORDER BY s.id
              FOR UPDATE OF s`, [documentId]);
        const rows = found.rows as Array<Record<string, any>>;
        if (!rows.length) {
          throw new DomainError("VALIDATION", `文書 ${documentId} に計算書がありません`);
        }

        const parties = new Set(rows.map((r) => Number(r.counterparty_id)));
        if (parties.size !== 1 || !rows[0].counterparty_id) {
          throw new DomainError("VALIDATION",
            "相手先が1件に決まりません。相手先ごとに計算書を分けてください");
        }
        const directions = new Set(rows.map((r) => String(r.direction)));
        if (directions.size !== 1) {
          throw new DomainError("VALIDATION", "取得と許諾が混ざった計算書からは支払を作れません");
        }
        const currencies = new Set(rows.map((r) => String(r.currency ?? "JPY")));
        if (currencies.size !== 1) {
          throw new DomainError("VALIDATION", "通貨の違う計算書は1件の支払にまとめられません");
        }

        // 同じ条件・実績に二重に支払を立てない。直すなら先の支払を取り消す。
        // 組で突き合わせる（条件だけで見ると、同じ条件の別の回まで塞いでしまう）。
        // 実績の無い計算書は 0 を置いて NULL と突き合わせる。
        const duplicated = await client.query(
          `SELECT p.id
             FROM payments p
             JOIN payment_allocations a ON a.payment_id = p.id
             JOIN unnest($1::bigint[], $2::bigint[]) AS t(condition_id, event_id)
               ON a.condition_id = t.condition_id
              AND a.event_id IS NOT DISTINCT FROM NULLIF(t.event_id, 0)
            WHERE p.status <> 'canceled'
            LIMIT 1`,
          [rows.map((r) => Number(r.condition_id)),
           rows.map((r) => (r.event_id === null || r.event_id === undefined ? 0 : Number(r.event_id)))]);
        if (duplicated.rows[0]) {
          throw new DomainError("CONFLICT",
            `この計算書にはすでに支払 #${(duplicated.rows[0] as { id: number }).id} があります`);
        }

        // 権利を許諾する側（out）は受け取る側なので入金、取得側（in）は支払。
        const direction: "in" | "out" = String(rows[0].direction) === "out" ? "in" : "out";
        const currency = String(rows[0].currency ?? "JPY");

        // 金額は計算書の値。すでに条件ごとの税区分で計算し直してある。
        let net = 0;
        let tax = 0;
        for (const r of rows) {
          const amount = Number(r.net_amount ?? 0);
          net += amount;
          tax += r.tax_amount === null || r.tax_amount === undefined
            ? consumptionTax(amount, taxRateFor({
                id: 0, conditionNo: null, currency, pricingModel: "none",
                ratePpm: null, unitAmount: null, flatAmount: null, mgAmount: null, agAmount: null,
                taxCategory: String(r.tax_category ?? "taxable") as "taxable" | "reduced" | "exempt"
              }))
            : Number(r.tax_amount);
        }
        if (net <= 0) throw new DomainError("VALIDATION", "金額が 0 の計算書からは支払を作れません");

        const withholdingEnabled = direction === "out" && resolveWithholdingEnabled({
          vendorWithholdingEnabled: rows[0].withholding === true,
          entityType: str(rows[0].party_kind)
        });
        const withholding = withholdingEnabled ? withholdingTax(net + tax, true) : 0;

        // 起算日は実績のいちばん遅い日。全部が出そろってからでないと支払は起きない。
        const dates = rows.map((r) => dateStr(r.occurred_on))
          .filter((d): d is string => Boolean(d)).sort();
        const basis = dates[dates.length - 1] ?? null;
        const dueOn = options.dueOn ?? dueLimitFrom(basis);

        return await this.writeWithAllocations(client, {
          direction, partyId: Number(rows[0].counterparty_id), partyKind: str(rows[0].party_kind),
          currency, net, tax, withholding, basis, dueOn,
          allocations: rows.map((r) => ({
            conditionId: Number(r.condition_id),
            eventId: r.event_id === null || r.event_id === undefined ? null : Number(r.event_id),
            amount: Number(r.net_amount ?? 0)
          })),
          detail: { documentId, statementIds: rows.map((r) => Number(r.statement_id)) }
        }, actor);
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 検収書から支払を立てる。
   *
   * 当社の支払は検収書か利用許諾計算書のどちらかから起きる。計算書のほうは
   * createFromStatementDocument が受け持つ。こちらは検収書で、文書に結び付いた実績
   * （condition_events.document_id）が支払の中身になる。
   *
   * 1枚の検収書に複数の実績が載る（条件をまたぐ委託料と実費など）。支払は
   * 1枚につき1件にし、実績ごとに割当を作る。経理提出用の「支払内容」は
   * その割当から出るので、行がそのまま経理の明細になる。
   */
  async createFromInspection(documentId: number, actor: string, options: { dueOn?: string | null } = {}) {
    try {
      return await inTransaction(this.database, async (client) => {
        const found = await client.query(
          `SELECT e.id AS event_id, e.amount, e.occurred_on, e.inspected_on, e.deliverable,
                  c.id AS condition_id, c.direction, c.tax_category, c.currency,
                  c.counterparty_id, c.payment_terms,
                  p.kind AS party_kind, p.withholding,
                  s.pay_on AS schedule_pay_on
             FROM condition_events e
             JOIN conditions c ON c.id = e.condition_id
             LEFT JOIN parties p ON p.id = c.counterparty_id
             LEFT JOIN condition_schedules s ON s.id = e.schedule_id
            WHERE e.document_id = $1 AND e.status = 'active'
            ORDER BY e.id
              FOR UPDATE OF e`, [documentId]);
        const rows = found.rows as Array<Record<string, any>>;
        if (!rows.length) {
          throw new DomainError("VALIDATION",
            "この文書に結び付いた実績がありません。実績から作った検収書だけが支払になります");
        }

        const parties = new Set(rows.map((r) => Number(r.counterparty_id)));
        if (parties.size !== 1 || !rows[0].counterparty_id) {
          throw new DomainError("VALIDATION",
            "相手先が1件に決まりません。相手先ごとに検収書を分けてください");
        }
        const directions = new Set(rows.map((r) => String(r.direction)));
        if (directions.size !== 1) {
          throw new DomainError("VALIDATION", "取得と許諾が混ざった文書からは支払を作れません");
        }

        // 同じ実績に二重に支払を立てない。直すなら先の支払を取り消す。
        const duplicated = await client.query(
          `SELECT p.id FROM payments p
             JOIN payment_allocations a ON a.payment_id = p.id
            WHERE a.event_id = ANY($1::bigint[]) AND p.status <> 'canceled'`,
          [rows.map((r) => Number(r.event_id))]);
        if (duplicated.rows[0]) {
          throw new DomainError("CONFLICT",
            `この検収書の実績にはすでに支払 #${(duplicated.rows[0] as { id: number }).id} があります`);
        }

        // 権利を許諾する側（out）は受け取る側なので入金、取得側（in）は支払。
        const direction: "in" | "out" = String(rows[0].direction) === "out" ? "in" : "out";
        const currency = String(rows[0].currency ?? "JPY");

        // 消費税は税区分ごとに掛けて足す。区分をまとめて10%にすると
        // 軽減や非課税が混じった検収書で合わなくなる。
        let net = 0;
        let tax = 0;
        for (const r of rows) {
          const amount = Number(r.amount ?? 0);
          net += amount;
          const rate = taxRateFor({
            id: 0, conditionNo: null, currency, pricingModel: "none",
            ratePpm: null, unitAmount: null, flatAmount: null, mgAmount: null, agAmount: null,
            taxCategory: String(r.tax_category ?? "taxable") as "taxable" | "reduced" | "exempt"
          });
          tax += consumptionTax(amount, rate);
        }
        if (net <= 0) throw new DomainError("VALIDATION", "金額が 0 の実績からは支払を作れません");

        const withholdingEnabled = direction === "out" && resolveWithholdingEnabled({
          vendorWithholdingEnabled: rows[0].withholding === true,
          entityType: str(rows[0].party_kind)
        });
        const withholding = withholdingEnabled ? withholdingTax(net + tax, true) : 0;

        // 起算日は検収日（無ければ納品日）のいちばん遅い日。全部が済んでからでないと
        // 支払は起きない。
        const basisDates = rows
          .map((r) => dateStr(r.inspected_on) ?? dateStr(r.occurred_on))
          .filter((d): d is string => Boolean(d))
          .sort();
        const basis = basisDates[basisDates.length - 1] ?? null;

        // 期日は予定の支払日をそのまま使う。回ごとに違えばいちばん遅い日。
        const payOns = rows.map((r) => dateStr(r.schedule_pay_on))
          .filter((d): d is string => Boolean(d)).sort();
        const dueOn = options.dueOn ?? payOns[payOns.length - 1] ?? dueLimitFrom(basis);

        return await this.writeWithAllocations(client, {
          direction, partyId: Number(rows[0].counterparty_id), partyKind: str(rows[0].party_kind),
          currency, net, tax, withholding, basis, dueOn,
          allocations: rows.map((r) => ({
            conditionId: Number(r.condition_id), eventId: Number(r.event_id),
            amount: Number(r.amount ?? 0)
          })),
          detail: { documentId, eventIds: rows.map((r) => Number(r.event_id)) }
        }, actor);
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
