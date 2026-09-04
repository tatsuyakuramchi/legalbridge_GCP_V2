// 経理提出用の税区分内訳（純関数・2026-09-04）。
// 検収書・利用許諾料計算書の form_data から、課税対象（10%）／課税対象（8%）／非課税・不課税／
// 消費税／税込合計を出す。Excel 一括出力の金額列がこれを使う。
//
// 検収書:
//   課税10% = 今回検収の納品額（税抜）＋ 手数料・経費のうち税区分 taxable の税抜額
//   課税8%  = 手数料・経費のうち reduced
//   非課税  = 手数料・経費のうち exempt
//   税区分の無い旧データの経費は「経費（税込・区分未設定）」として別列に出す（勝手に区分しない）。
//   旧データの手数料（区分なし）は従来の検収計算どおり課税10%扱い。
//   消費税 = ceil(課税10% × 税率) ＋ ceil(課税8% × 8%)。税込合計 = 各内訳＋消費税＋区分未設定経費。
// 計算書: 支払額（税抜）が課税10%、消費税・税込は共有エンジン（statementMoney）。

import { computeInspectionTotals } from "./inspection-totals.js";
import { statementMoney } from "./royalty-statement.js";
import { taxRateFor, type TaxCategory } from "./condition-ledger.js";

export interface TaxBreakdown {
  taxable10: number;
  reduced8: number;
  exempt: number;
  legacyIncTax: number;   // 税区分の無い旧データの経費（税込のまま）
  tax: number;
  totalIncTax: number;
}

const ZERO: TaxBreakdown = { taxable10: 0, reduced8: 0, exempt: 0, legacyIncTax: 0, tax: 0, totalIncTax: 0 };

const num = (value: unknown, fallback = 0): number => {
  if (value === "" || value == null) return fallback;
  const parsed = Number(String(value).replace(/[,¥\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
};
const rows = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value) ? value.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [];
const category = (row: Record<string, unknown>): TaxCategory | null => {
  const value = String(row.tax_category ?? "");
  return value === "taxable" || value === "reduced" || value === "exempt" ? value : null;
};

/** 経費行の税抜額（税区分あり）。amount_ex_tax があればそれ、無ければ税込額から逆算。 */
function expenseExTax(row: Record<string, unknown>, tax: TaxCategory): number {
  const ex = num(row.amount_ex_tax, Number.NaN);
  if (Number.isFinite(ex)) return ex;
  const inc = num(row.amount_inc_tax ?? row.amount);
  return Math.round(inc / (1 + taxRateFor(tax)));
}

export function inspectionTaxBreakdown(formData: Record<string, unknown>): TaxBreakdown {
  const totals = computeInspectionTotals(formData);
  const taxRate = totals.taxRate;
  let taxable10 = totals.deliveredExTax;
  let reduced8 = 0;
  let exempt = 0;
  let legacyIncTax = 0;
  for (const fee of rows(formData.other_fees)) {
    const amount = num(fee.amount_ex_tax ?? fee.amount);
    const tax = category(fee) ?? "taxable";          // 旧データの手数料は従来どおり課税
    if (tax === "taxable") taxable10 += amount;
    else if (tax === "reduced") reduced8 += amount;
    else exempt += amount;
  }
  for (const expense of rows(formData.expenses)) {
    const tax = category(expense);
    if (!tax) { legacyIncTax += num(expense.amount_inc_tax ?? expense.amount); continue; }
    const amount = expenseExTax(expense, tax);
    if (tax === "taxable") taxable10 += amount;
    else if (tax === "reduced") reduced8 += amount;
    else exempt += amount;
  }
  const tax = Math.ceil((taxable10 * taxRate) / 100) + Math.ceil(reduced8 * 0.08);
  return { taxable10, reduced8, exempt, legacyIncTax, tax, totalIncTax: taxable10 + reduced8 + exempt + tax + legacyIncTax };
}

export function statementTaxBreakdown(formData: Record<string, unknown>): TaxBreakdown {
  const money = statementMoney(formData);
  return { ...ZERO, taxable10: money.paymentExTax, tax: money.tax, totalIncTax: money.totalIncTax };
}

export function taxBreakdownFor(templateType: string, formData: Record<string, unknown>): TaxBreakdown {
  if (templateType === "royalty_statement") return statementTaxBreakdown(formData);
  if (templateType.startsWith("inspection_certificate")) return inspectionTaxBreakdown(formData);
  return { ...ZERO };
}

export function sumTaxBreakdown(items: TaxBreakdown[]): TaxBreakdown {
  return items.reduce<TaxBreakdown>((acc, b) => ({
    taxable10: acc.taxable10 + b.taxable10, reduced8: acc.reduced8 + b.reduced8, exempt: acc.exempt + b.exempt,
    legacyIncTax: acc.legacyIncTax + b.legacyIncTax, tax: acc.tax + b.tax, totalIncTax: acc.totalIncTax + b.totalIncTax
  }), { ...ZERO });
}
