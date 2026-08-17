// 発注書の自動集計（V1 DocumentForm / purchaseOrder スキーマ相当）。
// クライアント（入力中に画面へ反映）とサーバ（PDF 描画時の最終値）の両方から使うため、
// 副作用のない純関数としてここに置く。片側だけで計算すると、画面の合計と PDF の合計が
// ずれる（V2 ではサーバ側の grandTotalExTax が未計算で、手入力欄の値がそのまま出ていた）。

type Row = Record<string, unknown>;
type FormData = Record<string, unknown>;

function rows(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter((row): row is Row => Boolean(row) && typeof row === "object") : [];
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pick(row: Row, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

// 明細1行の確定額（税抜）。金額欄が空なら単価×数量で補う。
// 業績連動で金額0の行は「報酬は利用許諾料に含む」の意味なので、0 のまま合計に載せない。
export function lineAmountExTax(row: Row): number {
  const amount = num(pick(row, "amount_ex_tax", "amount", "subtotal"));
  if (amount) return amount;
  return num(pick(row, "unit_price", "unitPrice")) * num(pick(row, "quantity", "qty") ?? 1);
}

export interface PurchaseOrderTotals {
  itemsSubtotalExTax: number;
  otherFeesTotal: number;
  grandTotalExTax: number;
}

export function purchaseOrderTotals(formData: FormData): PurchaseOrderTotals {
  const itemsSubtotalExTax = rows(pick(formData as Row, "items", "line_items", "order_items"))
    .reduce((sum, row) => sum + lineAmountExTax(row), 0);
  const otherFeesTotal = rows(formData.other_fees)
    .reduce((sum, row) => sum + num(pick(row, "amount", "amount_ex_tax")), 0);
  return { itemsSubtotalExTax, otherFeesTotal, grandTotalExTax: itemsSubtotalExTax + otherFeesTotal };
}

// 明細の日付列をまとめて 1 つの表記にする（V1 Phase 22.7 と同じ規則）。
//   全部同じ日付 → その日付／複数 → 「最古 〜 最新 (明細参照)」／空 → 空文字。
// 定期支払の明細は納期・支払日を持たない（期間と支払日サイクルで表す）ので除く。
export function aggregateItemDates(
  items: unknown, field: "delivery_date" | "payment_date", intl = false
): string {
  const dates = rows(items)
    .filter((row) => String(row.calc_method ?? "") !== "SUBSCRIPTION")
    .map((row) => (typeof row[field] === "string" ? row[field].trim() : ""))
    .filter(Boolean) as string[];
  if (!dates.length) return "";
  const unique = [...new Set(dates)].sort();
  if (unique.length === 1) return unique[0];
  return intl
    ? `${unique[0]} – ${unique[unique.length - 1]} (see details)`
    : `${unique[0]} 〜 ${unique[unique.length - 1]} (明細参照)`;
}

export function isPurchaseOrderTemplate(templateKey: string): boolean {
  return templateKey === "purchase_order" || templateKey === "intl_purchase_order";
}

// 入力中のフォームへ集計結果を書き戻す。明細も手数料も無いときは何も触らない
// （明細を使わない発注書は合計金額を手入力する運用が V1 から残っている）。
export function withPurchaseOrderTotals(templateKey: string, formData: FormData): FormData {
  if (!isPurchaseOrderTemplate(templateKey)) return formData;
  const hasRows = rows(formData.items).length > 0 || rows(formData.other_fees).length > 0;
  if (!hasRows) return formData;
  const totals = purchaseOrderTotals(formData);
  const intl = templateKey === "intl_purchase_order";
  const summaryDeliveryDate = aggregateItemDates(formData.items, "delivery_date", intl);
  const summaryPaymentDate = aggregateItemDates(formData.items, "payment_date", intl);
  return {
    ...formData,
    itemsSubtotalExTax: totals.itemsSubtotalExTax,
    otherFeesTotal: totals.otherFeesTotal,
    grandTotalExTax: totals.grandTotalExTax,
    summaryDeliveryDate,
    // 海外発注書は納期キーが別名（テンプレートが summaryCompletionDate を読む）。
    ...(intl ? { summaryCompletionDate: summaryDeliveryDate } : {}),
    summaryPaymentDate
  };
}
