// Excel 一括出力の集計（純関数・Phase 10-5）。V1（services/worker/server.ts の
// excel-batches/pending）の deriveExcelGroupKey / グルーピングを移植。検収書・利用許諾料計算書を
// 「種別 × 担当者(検収者) × 支払期日」で束ねる。帳票化は client 側の export-util。
// 2026-09-04: 経理提出用の税区分内訳（課税10%／8%／非課税／消費税／税込）を文書ごと・グループ合計で付ける。

import { sumTaxBreakdown, taxBreakdownFor, type TaxBreakdown } from "../../document-tax-breakdown.js";
import { buildAccountingRow, type AccountingRow, type AccountingVendor } from "../../accounting-row.js";

export interface RawExcelDoc {
  documentNumber: string;
  templateType: string;
  formData: Record<string, unknown>;
  createdAt?: string;
  // 相手先（documents.vendor_id）の取引先マスタ。経理提出用レイアウトの取引先コード・カナ・源泉・T番号に使う。
  vendor?: AccountingVendor | null;
}

export interface ExcelBatchItem extends TaxBreakdown {
  documentNumber: string;
  inspectionDate: string;
  title: string;
  counterparty: string;
  // 経理提出用エクセル（V1 互換の 8 スロットレイアウト）の 1 行。
  accounting: AccountingRow;
}

export interface ExcelBatchGroup {
  key: string;
  category: "inspection_certificate" | "royalty_statement";
  inspectorEmail: string;
  inspectorName: string;
  paymentDate: string;
  count: number;
  documentNumbers: string[];
  items: ExcelBatchItem[];
  // 経理提出用の税区分内訳（グループ合計・2026-09-04）。
  totals: TaxBreakdown;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}
function firstNonEmpty(fd: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) { const v = str(fd[k]).trim(); if (v) return v; }
  return "";
}

// 種別・担当者・支払期日のグループキー（V1 deriveExcelGroupKey 準拠）。
export function deriveExcelGroupKey(templateType: string, fd: Record<string, unknown>) {
  const isRoyalty = templateType === "royalty_statement";
  const category: ExcelBatchGroup["category"] = isRoyalty ? "royalty_statement" : "inspection_certificate";
  const inspectorEmail = firstNonEmpty(fd, ["inspectorEmail", "STAFF_EMAIL", "staff_email"]);
  const inspectorName = firstNonEmpty(fd, ["inspectorName", "STAFF_NAME"]) || "(担当者未設定)";
  const rawDate = isRoyalty
    ? firstNonEmpty(fd, ["paymentDueDate", "documentDate"])
    : firstNonEmpty(fd, ["paymentDate", "payment_due_date", "documentDate"]);
  const paymentDate = rawDate ? rawDate.substring(0, 10) : "";
  return { category, inspectorEmail, inspectorName, paymentDate };
}

// 検収書/利用許諾料計算書を「種別×担当者×支払期日」で集計する。
export function groupExcelBatches(docs: RawExcelDoc[]): ExcelBatchGroup[] {
  const groups = new Map<string, ExcelBatchGroup>();
  for (const row of docs) {
    const fd = row.formData ?? {};
    const { category, inspectorEmail, inspectorName, paymentDate } = deriveExcelGroupKey(row.templateType, fd);
    const key = `${category}||${inspectorEmail}||${paymentDate}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, category, inspectorEmail, inspectorName, paymentDate, count: 0, documentNumbers: [], items: [], totals: sumTaxBreakdown([]) };
      groups.set(key, g);
    }
    g.count += 1;
    g.documentNumbers.push(row.documentNumber);
    g.items.push({
      documentNumber: row.documentNumber,
      inspectionDate: firstNonEmpty(fd, ["inspectionCompletedAt", "documentDate", "deliveredAt"]),
      // 計算書は件名・相手先のキーが検収書と違う（原著作物名・製品名／ライセンサー）。空欄で出ないよう
      // 計算書側のキーもたどる（2026-09-04）。
      title: firstNonEmpty(fd, ["description", "PROJECT_TITLE", "CONTRACT_TITLE", "contract_title", "件名",
        "contractTitle", "originalWork", "productName"]),
      counterparty: firstNonEmpty(fd, ["counterparty", "VENDOR_NAME", "取引先", "licensor", "designerName", "payerCompany"]),
      ...taxBreakdownFor(row.templateType, fd),
      accounting: buildAccountingRow(row.templateType, fd, row.vendor ?? null, paymentDate)
    });
  }
  for (const g of groups.values()) g.totals = sumTaxBreakdown(g.items);
  // 支払期日の昇順（空は末尾）→ 担当者名で安定化。
  return Array.from(groups.values()).sort((a, b) => {
    const ad = a.paymentDate || "9999-12-31";
    const bd = b.paymentDate || "9999-12-31";
    if (ad !== bd) return ad < bd ? -1 : 1;
    return a.inspectorName.localeCompare(b.inspectorName, "ja");
  });
}
