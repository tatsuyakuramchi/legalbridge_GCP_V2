/**
 * V1/V2 の合計計算の移植。
 *
 * 移行したひな形は V1 の本文をそのまま使っている。本文は合計を計算せず、
 * サーバが組んだ値（deliveredAmountStr・taxAmountStr・taxRate …）を差すだけ
 * なので、その値を作る側が無いと消費税が空欄のまま発行される。
 *
 * 式は V1 の inspection-totals.ts / purchase-order-totals.ts と同じにしてある。
 * 同じ書類が V1 と V3 で違う金額になってはいけない。
 */

import { roundAmount } from "../core/rounding.js";

export type TaxCategory = "taxable" | "reduced" | "exempt";

/** 税区分ごとの税率（%）。V1 の TAX_CATEGORY_OPTIONS と同じ。 */
export const TAX_RATE_PERCENT: Record<TaxCategory, number> = {
  taxable: 10,
  reduced: 8,
  exempt: 0
};

export function taxCategoryOf(value: unknown): TaxCategory | null {
  const s = String(value ?? "");
  return s === "taxable" || s === "reduced" || s === "exempt" ? s : null;
}

/** 税率（%）。区分が無いものは課税10%として扱う（V1 の既定と同じ）。 */
export function taxRatePercentFor(value: unknown): number {
  return TAX_RATE_PERCENT[taxCategoryOf(value) ?? "taxable"];
}

export type Row = Record<string, unknown>;

export function rows(value: unknown): Row[] {
  return Array.isArray(value)
    ? value.filter((row): row is Row => Boolean(row) && typeof row === "object" && !Array.isArray(row))
    : [];
}

/** 文字列の金額も受ける。「¥1,200」「1,200」どちらも 1200。 */
export function num(value: unknown, fallback = 0): number {
  if (value === "" || value === null || value === undefined) return fallback;
  const parsed = Number(String(value).replace(/[,¥￥\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function pickRow(row: Row, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return undefined;
}

/** 三桁区切り。本文が受け取るのは文字列なので、ここで整形して渡す。 */
export const yen = (value: number): string => Math.round(value).toLocaleString("ja-JP");

// ---------------------------------------------------------------------------
// 検収書
// ---------------------------------------------------------------------------

/**
 * 明細ごとの検収状態。V1 の inspectionLineStatus と同じ正規化。
 *   now  = 今回検収（この検収書の支払対象）
 *   paid = 検収済み（過去分・グループ表示には出るが今回の支払額に足さない）
 *   skip = 未検収（この検収書には載せない）
 */
export type InspectionLineStatus = "now" | "paid" | "skip";

export function inspectionLineStatus(line: Row): InspectionLineStatus {
  const status = String(line.inspection_status ?? "").trim().toLowerCase();
  if (["paid", "completed", "inspected", "検収済み", "支払済み", "支払済"].includes(status)) return "paid";
  if (["skip", "pending", "uninspected", "未検収", "対象外", "今回対象外"].includes(status)) return "skip";
  return "now";
}

export interface InspectionTotals {
  deliveredExTax: number;
  tax: number;
  totalIncTax: number;
  taxRate: number;
  lineCount: number;
  otherFeesExTax: number;
  expensesIncTax: number;
  grandTotalPayable: number;
  hasSettlement: boolean;
}

/**
 * 検収書の合計。式は V1 の computeInspectionTotals と同じ。
 *   税抜合計 → 消費税は切り上げ → 税込合計
 *   手数料は税抜＝検収額と合算して一括課税（二重課税しない）
 *   経費は税込のまま加算
 */
export function computeInspectionTotals(source: Row): InspectionTotals {
  const all = rows(pickRow(source, "delivery_line_items", "items", "line_items"));
  const lines = all.filter((line) => inspectionLineStatus(line) !== "skip");
  const payable = lines.filter((line) => inspectionLineStatus(line) === "now");
  const deliveredExTax = payable.reduce((sum, line) =>
    sum + num(pickRow(line, "inspected_amount_ex_tax", "amount_ex_tax", "amount")), 0);

  const raw = source.taxRate ?? source.tax_rate;
  // 未入力だけ 10% へ戻す。明示された 0%（非課税・不課税）を 10% にしない。
  const taxRate = raw === "" || raw === null || raw === undefined ? 10 : Math.max(0, num(raw, 10));
  const tax = Math.ceil((deliveredExTax * taxRate) / 100);

  const otherFeesExTax = rows(source.other_fees)
    .reduce((sum, fee) => sum + num(pickRow(fee, "amount_ex_tax", "amount")), 0);
  const expensesIncTax = rows(source.expenses)
    .reduce((sum, e) => sum + num(pickRow(e, "amount_inc_tax", "amount")), 0);

  const taxableSubtotal = deliveredExTax + otherFeesExTax;
  const combinedTax = Math.ceil((taxableSubtotal * taxRate) / 100);
  return {
    deliveredExTax, tax, totalIncTax: deliveredExTax + tax, taxRate, lineCount: lines.length,
    otherFeesExTax, expensesIncTax,
    grandTotalPayable: taxableSubtotal + combinedTax + expensesIncTax,
    hasSettlement: otherFeesExTax > 0 || expensesIncTax > 0
  };
}

// ---------------------------------------------------------------------------
// 発注書
// ---------------------------------------------------------------------------

/**
 * 明細1行の税抜額。金額欄が空なら単価×数量で補う。V1 と同じ。
 *
 * 行ごとに四捨五入する。数量が小数だと端数が出て、紙に並ぶ行の金額が
 * 端数のまま出るうえ、足しても合計に一致しなくなる。
 */
export function lineAmountExTax(row: Row): number {
  const amount = num(pickRow(row, "amount_ex_tax", "amount", "subtotal"));
  if (amount) return roundAmount(amount);
  return roundAmount(
    num(pickRow(row, "unit_price", "unitPrice")) * num(pickRow(row, "quantity", "qty") ?? 1));
}

export interface PurchaseOrderTotals {
  itemsSubtotalExTax: number;
  otherFeesTotal: number;
  grandTotalExTax: number;
}

export function purchaseOrderTotals(source: Row): PurchaseOrderTotals {
  const itemsSubtotalExTax = rows(pickRow(source, "items", "line_items", "order_items"))
    .reduce((sum, row) => sum + lineAmountExTax(row), 0);
  const otherFeesTotal = rows(source.other_fees)
    .reduce((sum, row) => sum + num(pickRow(row, "amount", "amount_ex_tax")), 0);
  return { itemsSubtotalExTax, otherFeesTotal, grandTotalExTax: itemsSubtotalExTax + otherFeesTotal };
}

/**
 * 明細の日付をひとつの表記にまとめる。V1 の aggregateItemDates と同じ規則。
 * 全部同じ日付ならその日付、ばらけていれば「最古 〜 最新 (明細参照)」。
 */
export function aggregateItemDates(
  items: unknown, field: "delivery_date" | "payment_date", intl = false
): string {
  const dates = rows(items)
    .filter((row) => String(row.calc_method ?? "") !== "SUBSCRIPTION")
    .map((row) => (typeof row[field] === "string" ? row[field].trim() : ""))
    .filter(Boolean);
  if (!dates.length) return "";
  const unique = [...new Set(dates)].sort();
  if (unique.length === 1) return unique[0];
  return intl
    ? `${unique[0]} – ${unique[unique.length - 1]} (see details)`
    : `${unique[0]} 〜 ${unique[unique.length - 1]} (明細参照)`;
}

// ---------------------------------------------------------------------------
// 税区分の内訳（経理提出用）
// ---------------------------------------------------------------------------

export interface TaxBreakdown {
  taxable10: number;
  reduced8: number;
  exempt: number;
  /** 税区分の無い旧データの経費（税込のまま）。勝手に区分しない。 */
  legacyIncTax: number;
  tax: number;
  totalIncTax: number;
}

const ZERO_BREAKDOWN: TaxBreakdown =
  { taxable10: 0, reduced8: 0, exempt: 0, legacyIncTax: 0, tax: 0, totalIncTax: 0 };

/** 経費行の税抜額。amount_ex_tax があればそれ、無ければ税込から逆算。 */
function expenseExTax(row: Row, category: TaxCategory): number {
  const ex = num(row.amount_ex_tax, Number.NaN);
  if (Number.isFinite(ex)) return ex;
  const inc = num(pickRow(row, "amount_inc_tax", "amount"));
  return Math.round(inc / (1 + TAX_RATE_PERCENT[category] / 100));
}

export function inspectionTaxBreakdown(source: Row): TaxBreakdown {
  const totals = computeInspectionTotals(source);
  let taxable10 = totals.deliveredExTax;
  let reduced8 = 0;
  let exempt = 0;
  let legacyIncTax = 0;
  for (const fee of rows(source.other_fees)) {
    const amount = num(pickRow(fee, "amount_ex_tax", "amount"));
    // 区分の無い旧データの手数料は、従来どおり課税扱い。
    const category = taxCategoryOf(fee.tax_category) ?? "taxable";
    if (category === "taxable") taxable10 += amount;
    else if (category === "reduced") reduced8 += amount;
    else exempt += amount;
  }
  for (const expense of rows(source.expenses)) {
    const category = taxCategoryOf(expense.tax_category);
    if (!category) { legacyIncTax += num(pickRow(expense, "amount_inc_tax", "amount")); continue; }
    const amount = expenseExTax(expense, category);
    if (category === "taxable") taxable10 += amount;
    else if (category === "reduced") reduced8 += amount;
    else exempt += amount;
  }
  const tax = Math.ceil((taxable10 * totals.taxRate) / 100) + Math.ceil(reduced8 * 0.08);
  return {
    taxable10, reduced8, exempt, legacyIncTax, tax,
    totalIncTax: taxable10 + reduced8 + exempt + tax + legacyIncTax
  };
}

export function emptyTaxBreakdown(): TaxBreakdown {
  return { ...ZERO_BREAKDOWN };
}
