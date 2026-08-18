// 検収書の合計（納品額・消費税・合計）。フォームの合計パネルと PDF（サーバの
// コンテキスト生成）が同じ関数を使う＝画面と PDF の合計を必ず一致させる。
// 式は V1 検収書と同じ：税抜合計 → 消費税は切り上げ → 税込合計。

export interface InspectionTotals {
  deliveredExTax: number;
  tax: number;
  totalIncTax: number;
  taxRate: number;
  lineCount: number;
  /** 精算に含めた手数料（税抜）。検収額と合算して一括課税（サーバと同じ）。 */
  otherFeesExTax: number;
  /** 精算に含めた経費（税込）。課税済みなのでそのまま加算。 */
  expensesIncTax: number;
  /** 検収＋手数料の一括課税後＋経費＝総支払額（源泉徴収前）。 */
  grandTotalPayable: number;
  hasSettlement: boolean;
}

function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function computeInspectionTotals(formData: Record<string, unknown>): InspectionTotals {
  const lines = Array.isArray(formData.delivery_line_items)
    ? formData.delivery_line_items as Array<Record<string, unknown>> : [];
  const deliveredExTax = lines.reduce((sum, line) =>
    sum + toNumber(line.inspected_amount_ex_tax ?? line.amount_ex_tax ?? line.amount), 0);
  const taxRate = toNumber(formData.taxRate ?? formData.tax_rate, 10) || 10;
  const tax = Math.ceil(deliveredExTax * taxRate / 100);
  // 経費・手数料（精算で選んだ行）。式はサーバの buildInspectionContext と同じ：
  // 手数料は税抜＝検収額と合算して一括課税（二重計上しない）、経費は税込のまま加算。
  const otherFees = Array.isArray(formData.other_fees)
    ? formData.other_fees as Array<Record<string, unknown>> : [];
  const otherFeesExTax = otherFees.reduce((sum, fee) =>
    sum + toNumber(fee.amount_ex_tax ?? fee.amount), 0);
  const expenses = Array.isArray(formData.expenses)
    ? formData.expenses as Array<Record<string, unknown>> : [];
  const expensesIncTax = expenses.reduce((sum, expense) =>
    sum + toNumber(expense.amount_inc_tax ?? expense.amount), 0);
  const taxableSubtotal = deliveredExTax + otherFeesExTax;
  const combinedTax = Math.ceil(taxableSubtotal * taxRate / 100);
  return {
    deliveredExTax, tax, totalIncTax: deliveredExTax + tax, taxRate, lineCount: lines.length,
    otherFeesExTax, expensesIncTax,
    grandTotalPayable: taxableSubtotal + combinedTax + expensesIncTax,
    hasSettlement: otherFeesExTax > 0 || expensesIncTax > 0
  };
}

export function formatYen(value: number): string {
  return Math.round(value).toLocaleString("ja-JP");
}
