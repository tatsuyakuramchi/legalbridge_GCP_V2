// 経理提出用エクセルの 1 行（V1 excelService.buildFromFormData の「支払スロット×8＋立替金／小計／
// 消費税／源泉税／税引後／差引振込額／インボイス登録」レイアウト）を V2 の文書から組み立てる（2026-09-04）。
//
// 旧システム（V1）が出していた同じ列並びのエクセルは、V2 の計算書（rs* 構造化入力）を読めず金額が
// 空になった。V2 側で同じレイアウトを、共有エンジン（税区分内訳・源泉計算）から出す。
//   支払内容(1..8): 検収書＝今回検収の明細（＋課税の手数料）、計算書＝契約（lineGroup）ごとの支払額
//   立替金: 非課税・不課税の経費・手数料＋税区分の無い旧経費（税込のまま）
//   小計: 課税対象の税抜合計（10%＋8%）／消費税／源泉税（税込ベース・個人または源泉ON）／
//   税引後＝税込−源泉／差引振込額＝税引後＋立替金

import { inspectionLineAmount, inspectionLineStatus, inspectionLines } from "./inspection-totals.js";
import { inspectionTaxBreakdown, statementTaxBreakdown, type TaxBreakdown } from "./document-tax-breakdown.js";
import { statementModeOf, structuredStatementPatch } from "./royalty-statement.js";
import { resolveWithholdingEnabled, withholdingTax } from "./royalty/tax.js";

export interface AccountingVendor {
  vendorCode: string | null;
  vendorName: string | null;
  vendorNameKana: string | null;
  entityType: string | null;
  withholdingEnabled: boolean | null;
  invoiceRegistrationNumber: string | null;
}

export interface AccountingSlot {
  content: string;
  unitPrice: number | "";
  quantity: number | "";
  amount: number | "";
  deliveryDate: string;
}

export interface AccountingRow {
  title: string;
  paymentDate: string;
  department: string;
  vendorCode: string;
  vendorName: string;
  vendorNameKana: string;
  slots: AccountingSlot[];        // 常に 8 要素（空スロットは空文字）
  reimbursement: number;          // 立替金（税込）
  subtotal: number;               // 課税対象の税抜小計
  consumptionTax: number;
  withholdingTax: number;
  afterTax: number;
  netTransfer: number;
  withholdingEnabled: boolean;
  invoiceRegistration: string;    // T番号（無ければ空）
  entityType: "個人" | "法人";     // V1 の出力単位（検収書(個人)／検収書(法人)）。マスタ→フォーム→源泉有無の順で決める
  breakdown: TaxBreakdown;
}

/** V1 経理提出用エクセルの列並び（53 列）。シート名は「検収書(個人)」のように種別＋区分。 */
export const ACCOUNTING_SHEET_HEADERS: string[] = [
  "件名", "支払日", "部署", "取引先コード", "氏名", "氏名（カナ）",
  ...Array.from({ length: 8 }, (_, i) => [
    `支払内容（${i + 1}）`, `単価（${i + 1}）`, `数量（${i + 1}）`, `金額（${i + 1}）`, `納品日(${i + 1})`
  ]).flat(),
  "立替金", "小計", "消費税", "源泉税", "税引後", "差引振込額", "インボイス登録"
];

/** 1 行分のセル（V1 と同じ: 空スロットは空、数値は数値のまま）。 */
export function accountingSheetRow(row: AccountingRow): Array<string | number | null> {
  const cell = (v: number | "" | string): string | number | null => (v === "" ? null : v);
  return [
    row.title, row.paymentDate, row.department, row.vendorCode, row.vendorName, row.vendorNameKana,
    ...row.slots.flatMap((s) => [cell(s.content), cell(s.unitPrice), cell(s.quantity), cell(s.amount), cell(s.deliveryDate)]),
    row.reimbursement, row.subtotal, row.consumptionTax, row.withholdingTax, row.afterTax, row.netTransfer,
    cell(row.invoiceRegistration)
  ];
}

function resolveEntityType(vendor: AccountingVendor | null, fd: Record<string, unknown>, withholdingEnabled: boolean): "個人" | "法人" {
  const raw = str(vendor?.entityType) || first(fd, ["vendorEntityType", "entity_type", "LICENSOR_IS_CORPORATION", "許諾者種別"]);
  if (/個人|individual|false/i.test(raw)) return "個人";
  if (/法人|corporation|corporate|company|true/i.test(raw)) return "法人";
  return withholdingEnabled ? "個人" : "法人";
}

export const ACCOUNTING_SLOT_COUNT = 8;

const num = (v: unknown, fallback = 0): number => {
  if (v === "" || v == null) return fallback;
  const n = Number(String(v).replace(/[,¥\s]/g, ""));
  return Number.isFinite(n) ? n : fallback;
};
const str = (v: unknown): string => (v == null ? "" : String(v).trim());
const first = (fd: Record<string, unknown>, keys: string[]): string => {
  for (const k of keys) { const v = str(fd[k]); if (v) return v; }
  return "";
};
const rows = (v: unknown): Array<Record<string, unknown>> =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [];
const emptySlot = (): AccountingSlot => ({ content: "", unitPrice: "", quantity: "", amount: "", deliveryDate: "" });

/** 9 件目以降は 8 件目に束ねる（内容を連結・金額を合算）。 */
export function fitSlots(slots: AccountingSlot[]): AccountingSlot[] {
  const fitted = slots.slice(0, ACCOUNTING_SLOT_COUNT);
  const rest = slots.slice(ACCOUNTING_SLOT_COUNT);
  if (rest.length) {
    const last = fitted[ACCOUNTING_SLOT_COUNT - 1];
    fitted[ACCOUNTING_SLOT_COUNT - 1] = {
      content: [last.content, ...rest.map((s) => s.content)].filter(Boolean).join("／"),
      unitPrice: "", quantity: "",
      amount: [last, ...rest].reduce((sum, s) => sum + (Number(s.amount) || 0), 0),
      deliveryDate: last.deliveryDate
    };
  }
  while (fitted.length < ACCOUNTING_SLOT_COUNT) fitted.push(emptySlot());
  return fitted;
}

function inspectionSlots(fd: Record<string, unknown>): AccountingSlot[] {
  const slots: AccountingSlot[] = inspectionLines(fd)
    .filter((line) => inspectionLineStatus(line) === "now")
    .map((line) => {
      const amount = inspectionLineAmount(line);
      const subscription = str(line.calc_method).toUpperCase() === "SUBSCRIPTION";
      const rawQuantity = line.inspected_quantity === "" || line.inspected_quantity == null
        ? "" : num(line.inspected_quantity);
      // サブスクを周期ごとに分割した1行は1期分。旧データの数量0をそのまま経理へ出さない。
      const quantity = subscription && amount > 0 && (rawQuantity === "" || rawQuantity <= 0)
        ? 1 : rawQuantity;
      const unitPrice = line.unit_price === "" || line.unit_price == null
        ? (subscription && amount > 0 ? amount : "")
        : num(line.unit_price);
      return {
        content: str(line.item_name), unitPrice, quantity, amount,
        deliveryDate: str(line.delivery_date).slice(0, 10)
      };
    });
  // 課税の手数料はスロットに載せる（非課税は立替金へ）。
  for (const fee of rows(fd.other_fees)) {
    const tax = str(fee.tax_category) || "taxable";
    if (tax === "exempt") continue;
    slots.push({ content: str(fee.fee_name ?? fee.item_name ?? fee.name) || "その他手数料", unitPrice: "", quantity: "",
      amount: num(fee.amount_ex_tax ?? fee.amount), deliveryDate: "" });
  }
  for (const expense of rows(fd.expenses)) {
    const tax = str(expense.tax_category);
    if (tax !== "taxable" && tax !== "reduced") continue;   // 非課税・区分なしは立替金
    const ex = expense.amount_ex_tax != null && expense.amount_ex_tax !== "" ? num(expense.amount_ex_tax)
      : Math.round(num(expense.amount_inc_tax ?? expense.amount) / (tax === "reduced" ? 1.08 : 1.1));
    slots.push({ content: str(expense.expense_name ?? expense.item_name ?? expense.name) || "経費", unitPrice: "", quantity: "", amount: ex, deliveryDate: "" });
  }
  return slots;
}

function statementSlots(fd: Record<string, unknown>): AccountingSlot[] {
  const patch = structuredStatementPatch(fd);
  const merged = patch ? { ...fd, ...patch } : fd;
  const label = first(fd, ["originalWork", "productName", "contractTitle"]);
  const date = first(fd, ["documentDate"]).slice(0, 10);
  const groups = rows(merged.lineGroups);
  if (statementModeOf(fd) !== "single" && groups.length) {
    return groups.map((g) => {
      const lines = rows(g.lines);
      const amount = lines.reduce((sum, l) => sum + num(l.paymentJpy ?? l.paymentJpyStr), 0);
      const name = str(g.contractTitle) || str(lines[0]?.productName) || label;
      return { content: `利用許諾料${name ? `（${name}）` : ""}`, unitPrice: "", quantity: "", amount, deliveryDate: date };
    });
  }
  const legacyLines = rows(fd.lines ?? fd.royalty_lines);
  if (statementModeOf(fd) !== "single" && legacyLines.length) {
    const amount = legacyLines.reduce((sum, line) => sum + num(
      line.paymentJpy ?? line.paymentJpyStr ?? line.payment ?? line.payment_amount ?? line.royalty_amount
    ), 0);
    const name = str(legacyLines[0]?.productName ?? legacyLines[0]?.product_name) || label;
    return [{ content: `利用許諾料${name ? `（${name}）` : ""}`, unitPrice: "", quantity: "", amount, deliveryDate: date }];
  }
  const money = statementTaxBreakdown(fd);
  return [{ content: `利用許諾料${label ? `（${label}）` : ""}`, unitPrice: "", quantity: "", amount: money.taxable10, deliveryDate: date }];
}

export function buildAccountingRow(
  templateType: string, fd: Record<string, unknown>, vendor: AccountingVendor | null, paymentDate: string
): AccountingRow {
  const isStatement = templateType === "royalty_statement";
  const breakdown = isStatement ? statementTaxBreakdown(fd) : inspectionTaxBreakdown(fd);
  const slots = fitSlots(isStatement ? statementSlots(fd) : inspectionSlots(fd));
  const subtotal = breakdown.taxable10 + breakdown.reduced8;
  const reimbursement = breakdown.exempt + breakdown.legacyIncTax;
  const withholdingEnabled = resolveWithholdingEnabled({
    vendorWithholdingEnabled: vendor?.withholdingEnabled ?? null,
    entityType: (vendor?.entityType ?? first(fd, ["LICENSOR_IS_CORPORATION", "vendorEntityType", "entity_type"])) || null,
    formOverride: fd.rsWithholding === true ? true : null
  });
  // 消費税は税区分内訳（8% を含む）を正とし、源泉は V1 と同じく「税込（小計＋消費税）」ベース
  // （10.21%・100万円超は 20.42%・個人または源泉ONのとき）。
  const consumptionTax = breakdown.tax;
  const taxIncluded = subtotal + consumptionTax;
  const withheld = withholdingTax(taxIncluded, withholdingEnabled);
  const afterTax = taxIncluded - withheld;
  const vendorName = str(vendor?.vendorName) || first(fd, ["counterparty", "VENDOR_NAME", "取引先", "licensor", "designerName"]);
  return {
    title: first(fd, ["description", "PROJECT_TITLE", "CONTRACT_TITLE", "contract_title", "件名"])
      || (isStatement ? `${first(fd, ["originalWork", "productName", "contractTitle"])} 利用許諾料`.trim() : ""),
    paymentDate,
    department: first(fd, ["STAFF_DEPARTMENT", "inspectorDept", "department"]),
    vendorCode: str(vendor?.vendorCode),
    vendorName,
    vendorNameKana: str(vendor?.vendorNameKana),
    slots,
    reimbursement,
    subtotal,
    consumptionTax,
    withholdingTax: withheld,
    afterTax,
    netTransfer: afterTax + reimbursement,
    withholdingEnabled,
    invoiceRegistration: str(vendor?.invoiceRegistrationNumber) || first(fd, ["invoiceRegistrationNumber", "INVOICE_REGISTRATION_NUMBER"]),
    entityType: resolveEntityType(vendor, fd, withholdingEnabled),
    breakdown
  };
}
