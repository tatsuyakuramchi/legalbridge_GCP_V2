/**
 * 発注書・検収書の「その他手数料」「経費」の行を、条件明細にする。
 *
 * 業務委託の1つの業務は 委託料＋実費＋手数料 の条件が組で動く。実費や手数料は
 * 発注書を作る段になって初めて分かることが多く、先に条件を作らせると
 * 「条件を作る → 文書へ戻る → 繋ぐ」の往復になる。逆に、文書の欄に打った
 * だけで台帳に無いと、実績も支払も付けられない行が紙にだけ残る。
 *
 * 決定（発行）のとき、条件の付いていない行から fee / expense の条件を作り、
 * 文書と案件に繋ぎ、行に condition_id を書き戻す。書き戻すので、作り直しや
 * 訂正版でもう一度決定しても二重には作らない。
 *
 * 相手先・契約・通貨・期間は、その文書に載っている最初の条件（委託料）から写す。
 * 載っている条件が無ければ相手先が決まらないので作らない（行は紙に出るだけ）。
 */

import type { Queryable } from "../core/db.js";
import { dateStr, int, str } from "../core/db.js";
import type { ConditionWriteService } from "../conditions/write-service.js";

type Row = Record<string, unknown>;

/** この処理が効くひな形。発注書と検収書は同じ行（other_fees / expenses）を持つ。 */
const SETTLEMENT_TEMPLATES = new Set([
  "purchase_order", "intl_purchase_order",
  "inspection_certificate", "intl_inspection_certificate", "delivery_note", "acceptance_certificate"
]);

const text = (v: unknown) => String(v ?? "").trim();
const amountOf = (v: unknown): number | null => {
  const n = Number(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return String(v ?? "").trim() === "" || !Number.isFinite(n) ? null : Math.round(n);
};
/** 空文字は「無い」として次の列を見る。画面の行は欄を空文字で持つ。 */
const firstAmount = (row: Row, ...keys: string[]): number | null => {
  for (const key of keys) { const n = amountOf(row[key]); if (n !== null) return n; }
  return null;
};
const rowsOf = (v: unknown): Row[] =>
  Array.isArray(v) ? v.filter((x): x is Row => Boolean(x) && typeof x === "object") : [];

/**
 * 経費の清算の仕方。
 *   reimbursement … 立替清算。相手が払った実費を返す。経理提出では「立替金」の列。
 *   compensation  … 報酬に含める。交通費等を報酬の一部として払う。経理提出では
 *                   支払内容（２）以降の組に載り、小計（税込）に入る。
 * 条件の税区分に写す：立替清算は非課税（消費税を重ねない・小計に入れない）、
 * 報酬に含めるは税込（内税。金額は税込のまま、小計に入って源泉の対象）。
 */
export type ExpenseSettlement = "reimbursement" | "compensation";
export const EXPENSE_SETTLEMENT_FIELD = "expense_type";

/** 行の清算区分。無ければ立替清算（切り替えを足す前の経費はすべて立替だった）。 */
export function expenseSettlementOf(row: Row): ExpenseSettlement {
  return text(row[EXPENSE_SETTLEMENT_FIELD]) === "compensation" ? "compensation" : "reimbursement";
}

/** 条件の税区分 → 清算区分。非課税だけが立替清算。税区分が分からなければ null。 */
export function settlementOfTaxCategory(taxCategory: unknown): ExpenseSettlement | null {
  const t = text(taxCategory);
  if (!t) return null;
  return t === "exempt" ? "reimbursement" : "compensation";
}

/** 清算区分 → 経費の条件の税区分。 */
export const taxCategoryForExpense = (settlement: ExpenseSettlement): "exempt" | "included" =>
  (settlement === "compensation" ? "included" : "exempt");

export interface SettlementSource {
  documentId: number;
  templateKey: string;
  matterId: number | null;
  /** 文書に載っている条件（line_no 順）。先頭が委託料で、相手先・契約の出どころ。 */
  conditionIds: number[];
  manual: Record<string, unknown>;
}

export interface SettlementResult {
  /** condition_id を書き戻した手入力。行が無ければ元のまま。 */
  manual: Record<string, unknown>;
  /** 作った条件。文書と案件に繋いである。 */
  created: Array<{ id: number; conditionNo: string | null; kind: "fee" | "expense"; name: string }>;
}

/**
 * 行から条件を作る。トランザクションは呼ぶ側が持つ。
 * 作った条件は document_conditions に足す（line_no は末尾）。
 */
export async function materializeSettlementRows(
  client: Queryable, writes: ConditionWriteService, source: SettlementSource, actor: string
): Promise<SettlementResult> {
  const created: SettlementResult["created"] = [];
  if (!SETTLEMENT_TEMPLATES.has(source.templateKey)) return { manual: source.manual, created };
  const fees = rowsOf(source.manual.other_fees);
  const expenses = rowsOf(source.manual.expenses);
  const pending = [
    ...fees.map((row) => ({ kind: "fee" as const, row, name: text(row.fee_name), amount: amountOf(row.amount) })),
    ...expenses.map((row) => ({ kind: "expense" as const, row, name: text(row.expense_name),
                                amount: firstAmount(row, "amount_inc_tax", "amount") }))
  ].filter((p) => !int(p.row.condition_id) && (p.name || (p.amount ?? 0) > 0));
  if (!pending.length) return { manual: source.manual, created };

  // 相手先・契約・通貨・期間は文書の先頭の条件（委託料）から。
  const headId = source.conditionIds[0];
  if (!headId) return { manual: source.manual, created };
  const head = await client.query(
    `SELECT counterparty_id, agreement_id, currency, term_start, term_end, tax_category
       FROM conditions WHERE id = $1`, [headId]);
  const primary = head.rows[0] as Record<string, any> | undefined;
  if (!primary) return { manual: source.manual, created };

  const last = await client.query(
    "SELECT COALESCE(max(line_no), 0) AS n FROM document_conditions WHERE document_id = $1",
    [source.documentId]);
  let lineNo = Number((last.rows[0] as { n: number } | undefined)?.n ?? 0);

  for (const p of pending) {
    const name = p.name || (p.kind === "fee" ? "その他手数料" : "経費");
    const settlement = p.kind === "expense" ? expenseSettlementOf(p.row) : null;
    const made = await writes.createWithin(client, {
      matterId: source.matterId,
      name,
      direction: "in",
      kind: p.kind,
      counterpartyId: Number(primary.counterparty_id),
      agreementId: int(primary.agreement_id),
      currency: str(primary.currency) ?? "JPY",
      pricingModel: "fixed",
      flatAmount: p.amount ?? 0,
      // 手数料は税抜で受け、経費は税込で受けるので消費税を重ねない。経費の税区分は
      // 清算区分で決める（立替清算＝非課税、報酬に含める＝税込・内税）。
      // 海外の取引（元の条件が税込・内税）の手数料は、元の条件と同じく税込にする。
      taxCategory: settlement ? taxCategoryForExpense(settlement)
        : primary.tax_category === "included" ? "included" : "taxable",
      termStart: dateStr(primary.term_start), termEnd: dateStr(primary.term_end),
      notes: settlement
        ? [text(p.row.spent_date) ? `利用日 ${text(p.row.spent_date)}` : "", text(p.row.remarks),
           settlement === "compensation" ? "税込（報酬に含める）" : "税込の実費（立替清算）"]
            .filter(Boolean).join("／")
        : text(p.row.remarks) || null
    }, actor);
    lineNo += 1;
    await client.query(
      `INSERT INTO document_conditions (document_id, condition_id, line_no)
       VALUES ($1, $2, $3) ON CONFLICT (document_id, condition_id) DO NOTHING`,
      [source.documentId, made.id, lineNo]);
    p.row.condition_id = made.id;
    created.push({ id: made.id, conditionNo: made.conditionNo, kind: p.kind, name });
  }
  return {
    manual: { ...source.manual,
      ...(fees.length ? { other_fees: fees } : {}),
      ...(expenses.length ? { expenses } : {}) },
    created
  };
}

/** 繋がっている手数料の条件 → その他手数料の行の種。 */
export function feeLinesFrom(conditions: Array<Record<string, any>>): Row[] {
  return conditions.filter((c) => c.kind === "fee").map((c) => ({
    condition_id: c.id, fee_name: c.name ?? "", amount: c.flatAmount ?? 0, remarks: c.notes ?? ""
  }));
}

/** 繋がっている経費の条件 → 経費の行の種（金額は税込）。清算区分は条件の税区分から。 */
export function expenseLinesFrom(conditions: Array<Record<string, any>>): Row[] {
  return conditions.filter((c) => c.kind === "expense").map((c) => ({
    condition_id: c.id, expense_name: c.name ?? "", amount_inc_tax: c.flatAmount ?? 0,
    spent_date: null, remarks: "",
    [EXPENSE_SETTLEMENT_FIELD]: settlementOfTaxCategory(c.taxCategory) ?? "reimbursement"
  }));
}

/** 発注書の品目から外す種類。手数料・経費は別の表（other_fees / expenses）に出る。 */
export const isSettlementKind = (kind: unknown): boolean => kind === "fee" || kind === "expense";

/** 実績を立てる行（検収書の経費・その他手数料のうち、条件の付いたもの）。 */
export interface SettlementEventRow {
  conditionId: number; kind: "fee" | "expense"; name: string; amount: number;
  /** 利用日。無ければ決定日で立てる。 */
  occurredOn: string | null; remarks: string | null;
}

/** 実績まで立てるひな形。発注書は実績の出どころではない（行は条件になるだけ）。 */
const EVENT_TEMPLATES = new Set([
  "inspection_certificate", "intl_inspection_certificate", "delivery_note", "acceptance_certificate"
]);

/**
 * 決定した検収書の経費・その他手数料の行（焼き付けた値）から、実績にする行を拾う。
 *
 * 支払は検収書に結び付いた実績から立つ（payments.createFromInspection）。行を打って
 * 条件ができても実績が無いと、紙に載った交通費が支払から落ちる。紙と支払を揃える
 * ため、ここで拾った行のうち、この文書に結び付いた実績の無い条件に実績を立てる。
 */
export function settlementEventRows(templateKey: string, values: Record<string, unknown>): SettlementEventRow[] {
  if (!EVENT_TEMPLATES.has(templateKey)) return [];
  const out: SettlementEventRow[] = [];
  const date = (v: unknown) => (/^\d{4}-\d{2}-\d{2}/.test(text(v)) ? text(v).slice(0, 10) : null);
  for (const row of rowsOf(values.expenses)) {
    const id = int(row.condition_id);
    const amount = firstAmount(row, "amount_inc_tax", "amount");
    if (id && amount && amount > 0) {
      out.push({ conditionId: id, kind: "expense", name: text(row.expense_name) || "経費", amount,
                 occurredOn: date(row.spent_date), remarks: text(row.remarks) || null });
    }
  }
  for (const row of rowsOf(values.other_fees)) {
    const id = int(row.condition_id);
    const amount = amountOf(row.amount);
    if (id && amount && amount > 0) {
      out.push({ conditionId: id, kind: "fee", name: text(row.fee_name) || "その他手数料", amount,
                 occurredOn: null, remarks: text(row.remarks) || null });
    }
  }
  return out;
}
