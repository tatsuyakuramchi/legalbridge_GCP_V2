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

// ── 束ね（statementMode: bundle・2026-09-04）────────────────────────────
// 複数の契約（条件明細）を 1 枚の計算書に束ねる。条件明細ごとに単票と同じ計算
// （グロス → MG floor → AG 充当）を行い、契約ごとの lineGroup にして印字する。
// テンプレートの描画は多明細（lineGroups）と同じ形にするため、PDF 文脈では
// statementMode を "multi" として渡す（フォーム側の保存値は "bundle" のまま）。

export type BundleEntry = {
  conditionLineId: number | null;   // 条件明細（記帳先）。無ければ手動記帳
  contractTitle: string;
  contractNumber: string;
  conditionName: string;
  calcType: "period" | "event";     // period=時限式（売上／受領額）・event=製造時等（数量×基準価格）
  basisKind: "sales" | "sublicense";
  msrp: number;                     // event: 基準価格（税抜）／period: 報告売上高・受領額
  quantity: number;
  sampleQuantity: number;
  ratePct: number;
  mgAmount: number;
  agAmount: number;
  agConsumedBefore: number;
  periodFrom: string;
  periodTo: string;
};

export function bundleEntriesFrom(formData: Record<string, unknown>): BundleEntry[] {
  const rows = Array.isArray(formData.rs_bundle) ? formData.rs_bundle as Array<Record<string, unknown>> : [];
  return rows.map((row) => ({
    conditionLineId: Math.trunc(toNumber(row.conditionLineId)) || null,
    contractTitle: String(row.contractTitle ?? ""),
    contractNumber: String(row.contractNumber ?? ""),
    conditionName: String(row.conditionName ?? ""),
    calcType: String(row.calcType) === "event" ? "event" : "period",
    basisKind: String(row.basisKind) === "sublicense" ? "sublicense" : "sales",
    msrp: toNumber(row.msrp),
    quantity: toNumber(row.quantity),
    sampleQuantity: toNumber(row.sampleQuantity),
    ratePct: toNumber(row.ratePct),
    mgAmount: toNumber(row.mgAmount),
    agAmount: toNumber(row.agAmount),
    agConsumedBefore: toNumber(row.agConsumedBefore),
    periodFrom: String(row.periodFrom ?? ""),
    periodTo: String(row.periodTo ?? "")
  }));
}

/** 束ねの1件が計算できる状態か（基準額が入っている）。 */
export function bundleEntryActive(entry: BundleEntry): boolean {
  return entry.msrp > 0;
}

export type BundleStatementResult = {
  entries: Array<{ entry: BundleEntry; fee: FeeResult; salesJpy: number }>;
  totalSalesJpy: number;
  totalPaymentJpy: number;
  tax: number;
  totalIncTax: number;
  patch: StatementPatch;
};

export function buildBundleStatementPatch(input: { entries: BundleEntry[]; taxRatePct?: number }): BundleStatementResult {
  const taxRate = Number(input.taxRatePct) || 10;
  const entries = input.entries.filter(bundleEntryActive).map((entry) => {
    const { fee } = buildSingleStatementPatch({
      calcType: entry.calcType === "event" ? "manufacturing" : entry.basisKind,
      msrp: entry.msrp, quantity: entry.quantity, sampleQuantity: entry.sampleQuantity,
      ratePct: entry.ratePct, mgAmount: entry.mgAmount, agAmount: entry.agAmount,
      agConsumedBefore: entry.agConsumedBefore, taxRatePct: taxRate
    });
    const salesJpy = entry.calcType === "event"
      ? Math.max(0, entry.quantity - entry.sampleQuantity) * entry.msrp
      : entry.msrp;
    return { entry, fee, salesJpy };
  });
  const lineGroups = entries.map(({ entry, fee, salesJpy }) => {
    const notes: string[] = [];
    if (entry.calcType === "period" && (entry.periodFrom || entry.periodTo)) {
      notes.push(`算定期間 ${entry.periodFrom || "—"}〜${entry.periodTo || "—"}`);
    }
    if (entry.calcType === "event") notes.push(`${Math.max(0, entry.quantity - entry.sampleQuantity)}個 × 基準価格`);
    if (fee.mg_floor_applied) notes.push(`MG適用 +${fmtYen(fee.mg_topup_this_time)}`);
    if (fee.ag_offset_this_time > 0) notes.push(`AG充当 −${fmtYen(fee.ag_offset_this_time)}`);
    return {
      contractTitle: entry.contractTitle,
      contractNumber: entry.contractNumber,
      methodLabel: entry.calcType === "event" ? "製造数量ベース"
        : entry.basisKind === "sublicense" ? "サブライセンス受領ベース" : "売上報告ベース",
      conditionLineId: entry.conditionLineId ?? "",
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
  const totalSalesJpy = entries.reduce((sum, e) => sum + e.salesJpy, 0);
  const totalPaymentJpy = entries.reduce((sum, e) => sum + e.fee.actual_ex_tax, 0);
  const tax = Math.ceil((totalPaymentJpy * taxRate) / 100);
  const patch: StatementPatch = {
    // PDF は多明細（lineGroups）と同じレイアウトで描く。
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
  return { entries, totalSalesJpy, totalPaymentJpy, tax, totalIncTax: totalPaymentJpy + tax, patch };
}

// ── 構造化入力（rs*）→ テンプレート変数（単票・多明細・束ね共通）─────────────
// サーバの PDF 文脈（template-context-adapters）と Excel 一括の金額列が同じ判定を使う。

type Data = Record<string, unknown>;
const records = (value: unknown): Data[] =>
  Array.isArray(value) ? value.filter((x): x is Data => !!x && typeof x === "object" && !Array.isArray(x)) : [];
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

export function statementModeOf(source: Data): "single" | "multi" | "bundle" {
  const mode = String(source.statementMode ?? "");
  return mode === "multi" || mode === "bundle" ? mode : "single";
}

/**
 * rs* の構造化入力が入っているときだけ、共有エンジンでテンプレート変数を組み立てる。
 * 旧下書き（手入力の *Str）は null を返し、そのまま通す。
 */
export function structuredStatementPatch(source: Data): StatementPatch | null {
  const mode = statementModeOf(source);
  const taxRatePct = num(pick(source, "taxRate", "tax_rate"), 10);
  if (mode === "bundle") {
    const entries = bundleEntriesFrom(source).filter(bundleEntryActive);
    return entries.length ? buildBundleStatementPatch({ entries, taxRatePct }).patch : null;
  }
  const receipts = records(source.rs_receipts)
    .filter((row) => String(pick(row, "sublicensee", "productName")).trim() !== "" || num(row.amount) > 0);
  if (mode === "multi" && receipts.length) {
    const ratePct = num(pick(source, "rsInRatePct", "rsRatePct", "royaltyRatePct"));
    return buildMultiStatementPatch({
      receipts: receipts.map((row) => ({
        sublicensee: String(pick(row, "sublicensee", "productName")),
        receivedOn: String(row.receivedOn ?? ""),
        currency: String(row.currency ?? "JPY"),
        amount: num(row.amount),
        fxMode: String(row.fxMode) === "post" ? "post" : "pre",
        fxRate: num(row.fxRate) || undefined,
        productName: row.productName == null ? undefined : String(row.productName)
      })),
      ratePct,
      taxRatePct,
      contractTitle: String(pick(source, "contractTitle", "CONTRACT_TITLE", "originalWork")),
      contractNumber: String(pick(source, "linked_contract_number", "CONTRACT_NO")),
      methodLabel: String(pick(source, "methodLabel", "royaltyCategory")) || "サブライセンス受領ベース"
    }).patch;
  }
  const calcBasis = String(source.rsCalcType ?? "");
  const msrp = num(source.rsMsrp);
  if (mode === "single" && calcBasis && msrp > 0) {
    const calcType = calcBasis === "event"
      ? "manufacturing"
      : String(source.rsBasisKind) === "sublicense" ? "sublicense" : "sales";
    const patch = buildSingleStatementPatch({
      calcType,
      msrp,
      quantity: num(source.rsQuantity),
      sampleQuantity: num(source.rsSampleQuantity),
      ratePct: num(pick(source, "rsRatePct", "royaltyRatePct")),
      mgAmount: num(source.rsMgAmount),
      agAmount: num(source.rsAgAmount),
      agConsumedBefore: num(source.rsAgConsumedBefore),
      taxRatePct
    }).patch;
    // 時限式は算定期間を備考の先頭に載せる（テンプレートに専用欄が無いため）。
    const from = String(source.rsPeriodFrom ?? "").trim();
    const to = String(source.rsPeriodTo ?? "").trim();
    if (calcBasis === "period" && (from || to)) {
      const periodNote = `算定期間: ${from || "—"} 〜 ${to || "—"}`;
      const notes = String(source.notes ?? "").trim();
      patch.notes = notes.startsWith("算定期間:") ? notes : [periodNote, notes].filter(Boolean).join("\n");
    }
    return patch;
  }
  return null;
}

/** 計算書の支払額（税抜）・消費税・税込（Excel 一括の金額列用）。旧下書きは印字値を読む。 */
export function statementMoney(source: Data): { paymentExTax: number; tax: number; totalIncTax: number } {
  const patch = structuredStatementPatch(source);
  const merged: Data = patch ? { ...source, ...patch } : source;
  const paymentExTax = patch && statementModeOf(source) === "single"
    ? num(merged.actualRoyalty)
    : num(pick(merged, "linesTotalPaymentJpy", "linesTotalPaymentStr", "actualRoyalty", "actualRoyaltyStr"));
  const tax = num(pick(merged, statementModeOf(source) === "single" ? "taxAmount" : "linesTaxStr", "taxAmount", "linesTaxStr"));
  const totalIncTax = num(pick(merged, statementModeOf(source) === "single" ? "totalPaymentStr" : "linesTotalIncTaxStr", "totalPaymentStr", "linesTotalIncTaxStr"));
  return { paymentExTax, tax, totalIncTax: totalIncTax || paymentExTax + tax };
}
