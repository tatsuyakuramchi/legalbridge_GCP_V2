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

// 明細ごとの検収状態（ロジック再構成・2026-08-18）。
//   now  = 今回検収（この検収書の支払対象）
//   paid = 検収済み（過去分・支払日ごとのグループ表示に載るが今回の支払額には含めない）
//   skip = 未検収（この検収書に載せない・後続の検収書で拾う）
// 旧下書き（inspection_status なし）は従来どおり全行 now 扱い。
export type InspectionLineStatus = "now" | "paid" | "skip";

export function inspectionLineStatus(line: Record<string, unknown>): InspectionLineStatus {
  const status = String(line.inspection_status ?? "").trim();
  return status === "paid" || status === "skip" ? status : "now";
}

export function inspectionLines(formData: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(formData.delivery_line_items)
    ? formData.delivery_line_items as Array<Record<string, unknown>> : [];
}

export function computeInspectionTotals(formData: Record<string, unknown>): InspectionTotals {
  const allLines = inspectionLines(formData);
  // PDF・合計に載るのは未検収（skip）以外。支払額（delivered）は今回検収（now）のみ
  // ＝検収済み（paid）の過去分は既に支払われているので今回の支払額に足さない。
  const lines = allLines.filter((line) => inspectionLineStatus(line) !== "skip");
  const payable = lines.filter((line) => inspectionLineStatus(line) === "now");
  const deliveredExTax = payable.reduce((sum, line) =>
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
