/**
 * 利用許諾料計算書のテンプレート変数。
 *
 * V1 の royalty-statement.ts の移植。本文（移行したひな形）が差す名前は
 * V1 のままなので、名前も 0=空文字の約束もそのままにしてある。
 * grossRoyaltyStr・agConsumedThisTimeStr・lineGroups … を作らないと、
 * 計算書は金額の入っていない紙になる。
 *
 * V1 との違いは計算のやり直しをしないこと。単票は V3 の試算（royalty）を
 * そのまま印字する。書類とデータベースの金額は同じ計算から出さないと合わない。
 * 多明細（rs_receipts）と束ね（rs_bundle）は V3 に相当する仕組みがまだ無いので、
 * V1 と同じく入力から計算する。
 */

import { calculateFee, type FeeResult } from "../royalty/calc.js";
import { computeStatementLine, convertToJpy } from "../royalty/fx.js";

type Data = Record<string, unknown>;

const fmtYen = (value: unknown) =>
  new Intl.NumberFormat("ja-JP").format(Math.round(Number(value) || 0));

/** 0 は空文字にする。本文の {{#if}} を偽にするための V1 の約束。 */
const nonZeroStr = (value: unknown) => (Number(value) > 0 ? fmtYen(value) : "");

const records = (value: unknown): Data[] =>
  Array.isArray(value)
    ? value.filter((x): x is Data => Boolean(x) && typeof x === "object" && !Array.isArray(x))
    : [];

const pick = (source: Data, ...keys: string[]): unknown => {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return "";
};

const num = (value: unknown, fallback = 0): number => {
  const parsed = Number.parseFloat(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
};

// ---------------------------------------------------------------------------
// 単票
// ---------------------------------------------------------------------------

export interface SingleStatementNumbers {
  calcType: "manufacturing" | "sales" | "sublicense";
  /** 製造時は基準価格（税抜）、時限式は報告売上・受領額。 */
  msrp: number;
  quantity: number;
  sampleQuantity: number;
  ratePct: number;
  mgAmount: number;
  agAmount: number;
  agConsumedBefore: number;
  taxRatePct: number;
  grossExTax: number;
  mgTopupThisTime: number;
  mgFloorApplied: boolean;
  agOffsetThisTime: number;
  agRemainingAfter: number;
  agFullyConsumed: boolean;
  actualExTax: number;
  taxAmount: number;
  totalIncTax: number;
}

/** V1 の buildSingleStatementPatch と同じ形・同じ約束で組む。 */
export function singleStatementPatch(n: SingleStatementNumbers): Data {
  const agConsumedAfter = n.agConsumedBefore + n.agOffsetThisTime;
  return {
    statementMode: "single",
    calcType: n.calcType,
    msrpStr: fmtYen(n.msrp),
    quantity: n.quantity ? String(n.quantity) : "",
    sampleQuantity: String(n.sampleQuantity),
    billableQuantity: String(Math.max(0, n.quantity - n.sampleQuantity)),
    royaltyRatePct: String(n.ratePct || 0),
    taxRate: String(n.taxRatePct),
    grossRoyaltyStr: fmtYen(n.grossExTax),
    mgAmount: nonZeroStr(n.mgAmount),
    mgAmountStr: nonZeroStr(n.mgAmount),
    mgTopupApplied: n.mgFloorApplied,
    mgTopupThisTime: n.mgTopupThisTime,
    mgTopupThisTimeStr: nonZeroStr(n.mgTopupThisTime),
    // MG は floor なので消化の概念が無い。V1 も空で出す。
    mgRemaining: "", mgConsumedBefore: "", mgConsumedThisTime: "", mgConsumedAfter: "",
    mgFullyConsumed: false,
    agAmount: nonZeroStr(n.agAmount),
    agAmountStr: nonZeroStr(n.agAmount),
    // 条件の AG 総額が読めなくても、充当が起きていれば AG の欄は出す。
    agApplied: n.agAmount > 0 || n.agOffsetThisTime > 0 || n.agConsumedBefore > 0,
    agConsumedBefore: nonZeroStr(n.agConsumedBefore),
    agConsumedBeforeStr: nonZeroStr(n.agConsumedBefore),
    agConsumedThisTime: nonZeroStr(n.agOffsetThisTime),
    agConsumedThisTimeStr: nonZeroStr(n.agOffsetThisTime),
    agConsumedAfter: nonZeroStr(agConsumedAfter),
    agConsumedAfterStr: nonZeroStr(agConsumedAfter),
    agRemaining: nonZeroStr(n.agRemainingAfter),
    agRemainingStr: nonZeroStr(n.agRemainingAfter),
    agFullyConsumed: n.agFullyConsumed,
    agProgressPct: n.agAmount > 0
      ? Math.min(100, Math.round((agConsumedAfter / (n.agAmount || 1)) * 100))
      : 0,
    actualRoyalty: n.actualExTax,
    actualRoyaltyStr: fmtYen(n.actualExTax),
    taxAmount: fmtYen(n.taxAmount),
    totalPaymentStr: fmtYen(n.totalIncTax)
  };
}

// ---------------------------------------------------------------------------
// 多明細（サブライセンシーごとの入金行）
// ---------------------------------------------------------------------------

export interface ReceiptRow {
  sublicensee: string;
  receivedOn?: string;
  currency: string;
  amount: number;
  /** pre = 交換前（外貨入金・入金日レートで円換算）／post = 交換後（円転済み）。 */
  fxMode: "pre" | "post";
  fxRate?: number;
  productName?: string;
}

export function receiptJpyBase(row: ReceiptRow): number {
  const amount = Number(row.amount) || 0;
  if (row.fxMode === "pre") {
    return convertToJpy(amount, row.currency || "JPY", Number(row.fxRate) || 0);
  }
  return Math.round(amount);
}

export function receiptConversionLabel(row: ReceiptRow): string {
  const currency = String(row.currency || "JPY").toUpperCase();
  if (row.fxMode === "pre") {
    if (currency === "JPY") return "JPY 入金（レート不要）";
    return `交換前 → 入金日レート ${row.fxRate ?? "未入力"}`;
  }
  return row.fxRate ? `交換後（円転済み）・適用レート ${row.fxRate}` : "交換後（円転済み）";
}

export function receiptAmountLabel(row: ReceiptRow): string {
  const currency = String(row.currency || "JPY").toUpperCase();
  const amount = Number(row.amount) || 0;
  if (row.fxMode === "pre" && currency !== "JPY") {
    return `${currency} ${new Intl.NumberFormat("en-US").format(amount)}`;
  }
  return `¥${fmtYen(amount)}`;
}

export interface MultiStatementInput {
  receipts: ReceiptRow[];
  ratePct: number;
  taxRatePct?: number;
  contractTitle?: string;
  contractNumber?: string;
  methodLabel?: string;
}

export function multiStatementPatch(input: MultiStatementInput): Data {
  const taxRate = Number(input.taxRatePct) || 10;
  const ratePct = Number(input.ratePct) || 0;
  const lines = input.receipts.map((row) => {
    // 換算は行ごと。pre は fx の convertToJpy（round）、支払は ceil。
    const line = row.fxMode === "pre"
      ? computeStatementLine({
          method: "revenue", salesInput: Number(row.amount) || 0,
          intakeCurrency: row.currency || "JPY", fxRate: Number(row.fxRate) || 0, ratePct
        })
      : computeStatementLine({
          method: "revenue", salesInput: receiptJpyBase(row), intakeCurrency: "JPY", ratePct
        });
    return {
      productName: row.productName?.trim() || row.sublicensee,
      salesJpy: line.salesJpy,
      salesJpyStr: fmtYen(line.salesJpy),
      ratePctResolved: String(ratePct),
      paymentJpy: line.paymentJpy,
      paymentJpyStr: fmtYen(line.paymentJpy),
      basisNote: receiptConversionLabel(row)
    };
  });
  const totalSalesJpy = lines.reduce((sum, l) => sum + l.salesJpy, 0);
  const totalPaymentJpy = lines.reduce((sum, l) => sum + l.paymentJpy, 0);
  const tax = Math.ceil((totalPaymentJpy * taxRate) / 100);
  return {
    statementMode: "multi",
    lineGroups: [{
      contractTitle: input.contractTitle ?? "",
      contractNumber: input.contractNumber ?? "",
      methodLabel: input.methodLabel ?? "サブライセンス受領ベース",
      lines,
      subtotalSales: totalSalesJpy,
      subtotalSalesStr: fmtYen(totalSalesJpy),
      subtotalPayment: totalPaymentJpy,
      subtotalPaymentStr: fmtYen(totalPaymentJpy)
    }],
    receiptRows: input.receipts.map((row) => ({
      sublicensee: row.sublicensee,
      receivedOn: row.receivedOn ?? "",
      amountStr: receiptAmountLabel(row),
      conversionStr: receiptConversionLabel(row),
      jpyBaseStr: fmtYen(receiptJpyBase(row))
    })),
    taxRate: String(taxRate),
    linesTotalSalesJpy: totalSalesJpy,
    linesTotalSalesStr: fmtYen(totalSalesJpy),
    linesTotalPaymentJpy: totalPaymentJpy,
    linesTotalPaymentStr: fmtYen(totalPaymentJpy),
    linesTaxStr: fmtYen(tax),
    linesTotalIncTaxStr: fmtYen(totalPaymentJpy + tax)
  };
}

// ---------------------------------------------------------------------------
// 束ね（複数の条件を1枚に）
// ---------------------------------------------------------------------------

export interface BundleEntry {
  conditionId: number | null;
  contractTitle: string;
  contractNumber: string;
  conditionName: string;
  /** period=時限式（売上／受領額）・event=製造時等（数量×基準価格）。 */
  calcType: "period" | "event";
  basisKind: "sales" | "sublicense";
  msrp: number;
  quantity: number;
  sampleQuantity: number;
  ratePct: number;
  mgAmount: number;
  agAmount: number;
  agConsumedBefore: number;
  periodFrom: string;
  periodTo: string;
}

export function bundleEntriesFrom(source: Data): BundleEntry[] {
  return records(source.rs_bundle).map((row) => ({
    conditionId: Math.trunc(num(pick(row, "conditionId", "conditionLineId"))) || null,
    contractTitle: String(row.contractTitle ?? ""),
    contractNumber: String(row.contractNumber ?? ""),
    conditionName: String(row.conditionName ?? ""),
    calcType: String(row.calcType) === "event" ? "event" : "period",
    basisKind: String(row.basisKind) === "sublicense" ? "sublicense" : "sales",
    msrp: num(row.msrp),
    quantity: num(row.quantity),
    sampleQuantity: num(row.sampleQuantity),
    ratePct: num(row.ratePct),
    mgAmount: num(row.mgAmount),
    agAmount: num(row.agAmount),
    agConsumedBefore: num(row.agConsumedBefore),
    periodFrom: String(row.periodFrom ?? ""),
    periodTo: String(row.periodTo ?? "")
  }));
}

/** 束ねの1件が計算できる状態か（基準額が入っている）。 */
export const bundleEntryActive = (entry: BundleEntry): boolean => entry.msrp > 0;

function feeFor(entry: BundleEntry, taxRatePct: number): FeeResult {
  const quantity = entry.quantity;
  return calculateFee(
    entry.calcType === "event"
      ? { type: "performance", base_price: entry.msrp, rate_pct: entry.ratePct, quantity }
      : { type: "revenue", base_amount: entry.msrp, rate_pct: entry.ratePct },
    {
      sample_quantity: entry.calcType === "event" ? entry.sampleQuantity : 0,
      mg_amount: entry.mgAmount,
      ag_amount: entry.agAmount,
      ag_consumed_before: entry.agConsumedBefore
    },
    taxRatePct
  );
}

export function bundleStatementPatch(
  input: { entries: BundleEntry[]; taxRatePct?: number }
): Data {
  const taxRate = Number(input.taxRatePct) || 10;
  const computed = input.entries.filter(bundleEntryActive).map((entry) => {
    const fee = feeFor(entry, taxRate);
    const salesJpy = entry.calcType === "event"
      ? Math.max(0, entry.quantity - entry.sampleQuantity) * entry.msrp
      : entry.msrp;
    return { entry, fee, salesJpy };
  });
  const lineGroups = computed.map(({ entry, fee, salesJpy }) => {
    const notes: string[] = [];
    if (entry.calcType === "period" && (entry.periodFrom || entry.periodTo)) {
      notes.push(`算定期間 ${entry.periodFrom || "—"}〜${entry.periodTo || "—"}`);
    }
    if (entry.calcType === "event") {
      notes.push(`${Math.max(0, entry.quantity - entry.sampleQuantity)}個 × 基準価格`);
    }
    if (fee.mg_floor_applied) notes.push(`MG適用 +${fmtYen(fee.mg_topup_this_time)}`);
    if (fee.ag_offset_this_time > 0) notes.push(`AG充当 −${fmtYen(fee.ag_offset_this_time)}`);
    return {
      contractTitle: entry.contractTitle,
      contractNumber: entry.contractNumber,
      methodLabel: entry.calcType === "event" ? "製造数量ベース"
        : entry.basisKind === "sublicense" ? "サブライセンス受領ベース" : "売上報告ベース",
      conditionId: entry.conditionId ?? "",
      lines: [{
        productName: entry.conditionName || entry.contractTitle || entry.contractNumber,
        salesJpy,
        salesJpyStr: fmtYen(salesJpy),
        ratePctResolved: String(entry.ratePct),
        paymentJpy: fee.actual_ex_tax,
        paymentJpyStr: fmtYen(fee.actual_ex_tax),
        basisNote: notes.join("・")
      }],
      subtotalSales: salesJpy,
      subtotalSalesStr: fmtYen(salesJpy),
      subtotalPayment: fee.actual_ex_tax,
      subtotalPaymentStr: fmtYen(fee.actual_ex_tax)
    };
  });
  const totalSalesJpy = computed.reduce((sum, e) => sum + e.salesJpy, 0);
  const totalPaymentJpy = computed.reduce((sum, e) => sum + e.fee.actual_ex_tax, 0);
  const tax = Math.ceil((totalPaymentJpy * taxRate) / 100);
  return {
    // 本文は多明細と同じ形で描く。保存側の statementMode は bundle のまま。
    statementMode: "multi",
    lineGroups,
    taxRate: String(taxRate),
    linesTotalSalesJpy: totalSalesJpy,
    linesTotalSalesStr: fmtYen(totalSalesJpy),
    linesTotalPaymentJpy: totalPaymentJpy,
    linesTotalPaymentStr: fmtYen(totalPaymentJpy),
    linesTaxStr: fmtYen(tax),
    linesTotalIncTaxStr: fmtYen(totalPaymentJpy + tax)
  };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export function statementModeOf(source: Data): "single" | "multi" | "bundle" {
  const mode = String(source.statementMode ?? "");
  return mode === "multi" || mode === "bundle" ? mode : "single";
}

/** 単票の数値を V3 の試算（context.royalty）と条件から組む。 */
export function singleNumbersFrom(context: Data, taxRatePct: number): SingleStatementNumbers | null {
  const royalty = context.royalty as Data | null | undefined;
  if (!royalty) return null;
  const condition = (context.condition ?? {}) as Data;
  const pricing = String(condition.pricingModel ?? "");
  // 数量を報告しているものは製造時等（数量×基準価格）。
  const quantity = num(royalty.quantity);
  const calcType: SingleStatementNumbers["calcType"] =
    pricing === "per_unit" || quantity > 0
      ? "manufacturing"
      : String(condition.kind) === "license" && String(condition.direction) === "in"
        ? "sublicense" : "sales";
  return {
    calcType,
    msrp: num(royalty.salesInput) || num(condition.unitAmount),
    quantity,
    sampleQuantity: num(royalty.sampleQuantity),
    ratePct: num(condition.ratePct),
    mgAmount: num(condition.mgAmount),
    agAmount: num(condition.agAmount),
    agConsumedBefore: num(royalty.agConsumedBefore),
    taxRatePct,
    grossExTax: num(royalty.grossExTax),
    mgTopupThisTime: num(royalty.mgTopup),
    mgFloorApplied: num(royalty.mgTopup) > 0,
    agOffsetThisTime: num(royalty.agOffset),
    agRemainingAfter: num(royalty.agRemaining),
    agFullyConsumed: num(royalty.agRemaining) <= 0 && num(condition.agAmount) > 0,
    actualExTax: num(royalty.netExTax),
    taxAmount: num(royalty.taxAmount),
    totalIncTax: num(royalty.totalIncTax)
  };
}

/**
 * 計算書のテンプレート変数を組む。
 *
 * 束ね（rs_bundle）→ 多明細（rs_receipts）→ 単票（V3 の試算）の順に見る。
 * どれも無ければ null。手入力の下書きはそのまま通す（V1 と同じ）。
 */
export function royaltyStatementPatch(
  context: Data, manual: Data = {}, taxRatePct = 10
): Data | null {
  const mode = statementModeOf(manual);
  const rate = num(pick(manual, "taxRate", "tax_rate"), taxRatePct);

  if (mode === "bundle") {
    const entries = bundleEntriesFrom(manual).filter(bundleEntryActive);
    return entries.length ? bundleStatementPatch({ entries, taxRatePct: rate }) : null;
  }

  const receipts = records(manual.rs_receipts)
    .filter((row) => String(pick(row, "sublicensee", "productName")).trim() !== "" || num(row.amount) > 0);
  // 印字済みの文字列だけを持つ旧下書きは計算し直さない（receiptRows をそのまま通す）。
  const legacyOnly = receipts.length > 0 &&
    receipts.every((row) => row.amount == null && (row.amountStr != null || row.jpyBaseStr != null));
  if (receipts.length && !legacyOnly) {
    const condition = (context.condition ?? {}) as Data;
    const agreement = (context.agreement ?? {}) as Data;
    return multiStatementPatch({
      receipts: receipts.map((row) => ({
        sublicensee: String(pick(row, "sublicensee", "productName")),
        receivedOn: String(row.receivedOn ?? ""),
        currency: String(row.currency ?? "JPY"),
        amount: num(row.amount),
        fxMode: String(row.fxMode) === "post" ? "post" : "pre",
        fxRate: num(row.fxRate) || undefined,
        productName: row.productName == null ? undefined : String(row.productName)
      })),
      ratePct: num(pick(manual, "rsInRatePct", "rsRatePct", "royaltyRatePct"), num(condition.ratePct)),
      taxRatePct: rate,
      contractTitle: String(pick(manual, "contractTitle", "CONTRACT_TITLE")
        || agreement.title || condition.name || ""),
      contractNumber: String(pick(manual, "linked_contract_number", "CONTRACT_NO")
        || agreement.no || condition.conditionNo || ""),
      methodLabel: String(pick(manual, "methodLabel", "royaltyCategory")) || "サブライセンス受領ベース"
    });
  }

  const numbers = singleNumbersFrom(context, rate);
  if (!numbers) return null;
  const patch = singleStatementPatch(numbers);
  // 算定期間は本文に専用の枠が無いので、備考の先頭に載せる（V1 と同じ）。
  const period = String(pick(manual, "rsPeriodFrom") || "").trim();
  const to = String(pick(manual, "rsPeriodTo") || "").trim();
  if (numbers.calcType !== "manufacturing" && (period || to)) {
    const note = `算定期間: ${period || "—"} 〜 ${to || "—"}`;
    const notes = String(manual.notes ?? "").trim();
    patch.notes = notes.startsWith("算定期間:") ? notes : [note, notes].filter(Boolean).join("\n");
  }
  return patch;
}
