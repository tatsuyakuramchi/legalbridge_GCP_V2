// 検収書の合計（納品額・消費税・合計）。フォームの合計パネルと PDF（サーバの
// コンテキスト生成）が同じ関数を使う＝画面と PDF の合計を必ず一致させる。
// 式は V1 検収書と同じ：税抜合計 → 消費税は切り上げ → 税込合計。

export interface InspectionTotals {
  deliveredExTax: number;
  tax: number;
  totalIncTax: number;
  taxRate: number;
  lineCount: number;
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
  return { deliveredExTax, tax, totalIncTax: deliveredExTax + tax, taxRate, lineCount: lines.length };
}

export function formatYen(value: number): string {
  return Math.round(value).toLocaleString("ja-JP");
}
