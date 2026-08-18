/**
 * 利用許諾料計算書のフォーム／PDF 変数組み立て（純関数・DB非依存）。
 *
 * V1 `royaltyStatement.tsx` の onPreview パッチ（単票）と computeLine 集計（多明細）を
 * V2 の共有計算エンジン（royalty/calc・tax・fx）の上に忠実移植したもの。
 * クライアントのライブ計算（右レール）とサーバの PDF 文脈（template-context-adapters）の
 * 両方がこのモジュールを使う＝画面の金額と PDF の金額は必ず一致する。
 *
 * 単票（statementMode: single）
 *   calcType manufacturing = イベント式（製造時等）: 数量×基準価格×料率
 *   calcType sales / sublicense = 時限式（算定期間の売上報告／被許諾者受領額）× 料率
 *   MG = 最低保証（floor・グロスが下回ったら MG を採用）、AG = 前払保証金の累積消化。
 *   0 のときは空文字にして Handlebars の {{#if}} を false にする（V1 の nonZeroStr と同じ）。
 *
 * 多明細（statementMode: multi）
 *   サブライセンシーごとの入金行 → 円 base × イン側料率 = 支払額（行ごと ceil）。
 *   行ごとに通貨・換算方法を持てる（V1 は 1 計算書 1 レートだった拡張点）:
 *     fxMode "pre"  = 交換前入金（外貨）→ 入金日レートで円換算（round・V1 と同じ丸め）
 *     fxMode "post" = 交換後入金（円転済み）→ 円額を base に、適用レートは記録として印字
 */
import { calculateFee, type FeeResult } from "./royalty/calc.js";
import { computeRoyaltyPayment, type PaymentBreakdown } from "./royalty/tax.js";
import { computeStatementLine, convertToJpy } from "./royalty/fx.js";

export type StatementPatch = Record<string, unknown>;

const fmtYen = (value: number) => new Intl.NumberFormat("ja-JP").format(Math.round(Number(value) || 0));
const nonZeroStr = (value: number) => (Number(value) > 0 ? fmtYen(value) : "");

export function toNumber(value: unknown): number {
  if (value === "" || value == null) return 0;
  const parsed = Number(String(value).replace(/[,¥\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

// ── 単票 ─────────────────────────────────────────────────────────────

export type SingleStatementInput = {
  calcType: "manufacturing" | "sales" | "sublicense";
  /** manufacturing: 基準価格（税抜）／sales: 報告売上高／sublicense: 被許諾者受領額 */
  msrp: number;
  quantity?: number;        // manufacturing のみ
  sampleQuantity?: number;  // manufacturing のみ（計算対象外の販促サンプル）
  ratePct: number;
  mgAmount?: number;
  agAmount?: number;
  agConsumedBefore?: number;
  taxRatePct?: number;
};

export type SingleStatementResult = {
  fee: FeeResult;
  patch: StatementPatch;
};

export function buildSingleStatementPatch(input: SingleStatementInput): SingleStatementResult {
  const taxRate = Number(input.taxRatePct) || 10;
  const quantity = Number(input.quantity) || 0;
  const sample = Number(input.sampleQuantity) || 0;
  const fee = calculateFee(
    input.calcType === "manufacturing"
      ? { type: "performance", base_price: input.msrp, rate_pct: input.ratePct, quantity }
      : { type: "revenue", base_amount: input.msrp, rate_pct: input.ratePct },
    {
      sample_quantity: input.calcType === "manufacturing" ? sample : 0,
      mg_amount: input.mgAmount,
      ag_amount: input.agAmount,
      ag_consumed_before: input.agConsumedBefore
    },
    taxRate
  );
  const agAmount = Number(input.agAmount) || 0;
  const agConsumedBefore = Number(input.agConsumedBefore) || 0;
  const agConsumedAfter = agConsumedBefore + fee.ag_offset_this_time;
  // V1 onPreview のパッチと同じフィールド・同じ 0=空文字規約。
  const patch: StatementPatch = {
    calcType: input.calcType,
    msrpStr: fmtYen(input.msrp),
    quantity: quantity ? String(quantity) : "",
    sampleQuantity: String(sample),
    billableQuantity: String(Math.max(0, quantity - sample)),
    royaltyRatePct: String(Number(input.ratePct) || 0),
    taxRate: String(taxRate),
    grossRoyaltyStr: fmtYen(fee.gross_ex_tax),
    mgAmount: nonZeroStr(Number(input.mgAmount) || 0),
    mgAmountStr: nonZeroStr(Number(input.mgAmount) || 0),
    mgTopupApplied: fee.mg_floor_applied,
    mgTopupThisTime: fee.mg_topup_this_time,
    mgTopupThisTimeStr: nonZeroStr(fee.mg_topup_this_time),
    mgRemaining: "", mgConsumedBefore: "", mgConsumedThisTime: "", mgConsumedAfter: "",
    mgFullyConsumed: false,
    agAmount: nonZeroStr(agAmount),
    agAmountStr: nonZeroStr(agAmount),
    agApplied: agAmount > 0,
    agConsumedBefore: nonZeroStr(agConsumedBefore),
    agConsumedBeforeStr: nonZeroStr(agConsumedBefore),
    agConsumedThisTime: nonZeroStr(fee.ag_offset_this_time),
    agConsumedThisTimeStr: nonZeroStr(fee.ag_offset_this_time),
    agConsumedAfter: nonZeroStr(agConsumedAfter),
    agConsumedAfterStr: nonZeroStr(agConsumedAfter),
    agRemaining: nonZeroStr(fee.ag_remaining_after),
    agRemainingStr: nonZeroStr(fee.ag_remaining_after),
    agFullyConsumed: fee.ag_fully_consumed,
    agProgressPct: agAmount > 0
      ? Math.min(100, Math.round((agConsumedAfter / (agAmount || 1)) * 100))
      : 0,
    actualRoyalty: fee.actual_ex_tax,
    actualRoyaltyStr: fmtYen(fee.actual_ex_tax),
    taxAmount: fmtYen(fee.tax_amount),
    totalPaymentStr: fmtYen(fee.total_inc_tax),
    statementMode: "single"
  };
  return { fee, patch };
}

// ── 多明細（サブライセンシーごとの入金行）──────────────────────────────

export type StatementReceiptRow = {
  sublicensee: string;
  receivedOn?: string;
  currency: string;          // 入金通貨（例 USD / JPY）
  amount: number;            // 入金額（fxMode pre は外貨額、post は円額）
  fxMode: "pre" | "post";    // 交換前（外貨入金）／交換後（円転済み）
  fxRate?: number;           // pre: 入金日レート（必須）／post: 適用レート（記録用・任意）
  productName?: string;      // 明細に出す名称（省略時はサブライセンシー名）
};

export function receiptJpyBase(row: StatementReceiptRow): number {
  const amount = Number(row.amount) || 0;
  if (row.fxMode === "pre") {
    return convertToJpy(amount, row.currency || "JPY", Number(row.fxRate) || 0);
  }
  return Math.round(amount);
}

export function receiptConversionLabel(row: StatementReceiptRow): string {
  const currency = String(row.currency || "JPY").toUpperCase();
  if (row.fxMode === "pre") {
    if (currency === "JPY") return "JPY 入金（レート不要）";
    return `交換前 → 入金日レート ${row.fxRate ?? "未入力"}`;
  }
  return row.fxRate
    ? `交換後（円転済み）・適用レート ${row.fxRate}`
    : "交換後（円転済み）";
}

export function receiptAmountLabel(row: StatementReceiptRow): string {
  const currency = String(row.currency || "JPY").toUpperCase();
  const amount = Number(row.amount) || 0;
  if (row.fxMode === "pre" && currency !== "JPY") {
    return `${currency} ${new Intl.NumberFormat("en-US").format(amount)}`;
  }
  return `¥${fmtYen(amount)}`;
}

export type MultiStatementInput = {
  receipts: StatementReceiptRow[];
  ratePct: number;             // イン側（支払側）の料率
  taxRatePct?: number;
  contractTitle?: string;
  contractNumber?: string;
  methodLabel?: string;        // 例: サブライセンス受領ベース
};

export type MultiStatementResult = {
  totalSalesJpy: number;
  totalPaymentJpy: number;
  tax: number;
  totalIncTax: number;
  patch: StatementPatch;
};

export function buildMultiStatementPatch(input: MultiStatementInput): MultiStatementResult {
  const taxRate = Number(input.taxRatePct) || 10;
  const ratePct = Number(input.ratePct) || 0;
  const lines = input.receipts.map((row) => {
    // 換算は行ごと（V1 の 1 計算書 1 レートからの拡張）。pre は fx.ts の convertToJpy と
    // 同じ丸め（round）、支払は ceil（computeStatementLine の revenue パス）。
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
  const totalSalesJpy = lines.reduce((sum, line) => sum + line.salesJpy, 0);
  const totalPaymentJpy = lines.reduce((sum, line) => sum + line.paymentJpy, 0);
  const tax = Math.ceil((totalPaymentJpy * taxRate) / 100);
  const patch: StatementPatch = {
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
    // テンプレート拡張（■受領情報の明細表）用。旧版テンプレートはこの変数を知らないので
    // 存在しても無害（label テーブルのまま）。
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
  return { totalSalesJpy, totalPaymentJpy, tax, totalIncTax: totalPaymentJpy + tax, patch };
}

// ── 右レール表示用（源泉は PDF に出ない参考値・支払処理側で控除）────────

export function statementPaymentInfo(input: {
  subtotalExTax: number;
  taxRatePct?: number;
  withholdingEnabled: boolean;
}): PaymentBreakdown {
  return computeRoyaltyPayment({
    subtotalExTax: input.subtotalExTax,
    taxRatePct: input.taxRatePct,
    withholdingEnabled: input.withholdingEnabled
  });
}

export const formatStatementYen = fmtYen;
