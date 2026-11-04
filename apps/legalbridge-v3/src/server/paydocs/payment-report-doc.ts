import { isRoyaltyStatementKey, SERVICE_COMPLETION_KEY } from "../documents/settlement-docs.js";

/**
 * 支払報告書（payment_report）：許諾者・受注者ごとに、一定期間の支払を 1 通にまとめる。
 *
 * 決定済みの決済文書（検収書・役務提供完了通知書・利用許諾料計算書）を相手先で集め、
 *   1. 支払日ごとの一覧（文書 1 件 = 1 行。支払日の見出しで区切る）
 *   2. 文書ごとの明細（検収書は紙に刷った明細の行、計算書は計算書の明細）
 * に並べる。ひな形は infra/v3/templates/payment_report.html（検収書 v2 の件数が多い版の組み方）。
 *
 * ここ（payment-report-doc.ts）は DB を触らない。行の読み込みと描画は payment-report-service.ts。
 *
 * 支払日の決め方（文書 1 件ごと）：
 *   - 文書の実績に支払（payments。取り消しを除く）が立っていれば、支払済みは支払日、未払いは期日。
 *     支払が複数（分納）なら最も遅い日。
 *   - 支払が無ければ、文書に刷った支払予定日（PAYMENT_DATE など）。
 * 金額は支払があれば支払の額（その文書の実績に割り当てた分だけ按分）。無ければ文書の明細から。
 */

export type PaymentReportBasis = "pay" | "paid" | "issued";

export const BASIS_LABELS: Record<PaymentReportBasis, string> = {
  pay: "支払日基準（未払いは支払予定日）",
  paid: "支払日基準（支払済みのみ）",
  issued: "文書の発行日基準"
};

export type DocKind = "inspection" | "completion" | "statement";

export const KIND_LABELS: Record<DocKind, string> = {
  inspection: "検収書",
  completion: "役務提供完了通知書",
  statement: "利用許諾料計算書"
};

/** 支払報告書に載せるひな形の鍵。決済文書のうち、相手へ支払うもの。 */
export const REPORT_SOURCE_KEYS = [
  "inspection_certificate", "intl_inspection_certificate", SERVICE_COMPLETION_KEY,
  "royalty_statement", "royalty_statement_pub"
];

export const kindOfKey = (templateKey: string | null): DocKind =>
  isRoyaltyStatementKey(templateKey) ? "statement"
    : templateKey === SERVICE_COMPLETION_KEY ? "completion" : "inspection";

// ---------------------------------------------------------------------------
// 入力（DB から読んだ形）
// ---------------------------------------------------------------------------

export interface RawStatementLine {
  statementId: number; period: string | null; productName: string | null;
  quantity: number | null; sampleQuantity: number | null; unitAmount: number | null;
  ratePpm: number | null; salesInput: number | null; amount: number;
  conditionName: string | null; conditionNo: string | null;
}
export interface RawStatement { id: number; period: string | null; currency: string; netAmount: number; taxAmount: number }
export interface RawEvent {
  id: number; occurredOn: string | null; quantity: number | null; amount: number;
  period: string | null; conditionName: string | null; conditionNo: string | null; currency: string | null;
}
export interface RawPayment {
  id: number; paymentNo: string | null; currency: string; amount: number; taxAmount: number;
  withholdingAmount: number; dueOn: string | null; paidOn: string | null; status: string;
  /** この文書の実績に割り当てた額と、その支払の割当の合計。按分に使う。 */
  allocated: number; allocatedTotal: number;
}
export interface RawDoc {
  id: number; documentNo: string | null; templateKey: string | null; templateLabel: string | null;
  title: string | null; issuedOn: string | null;
  /** 紙に刷った支払予定日（PAYMENT_DATE ほか）。日付として読めないものは null。 */
  printedPayOn: string | null;
  /** 発行時点のスナップショット（rendered_values）のうち、明細と合計に使うもの。 */
  rendered: {
    deliveryLines?: unknown; otherFees?: unknown; expenses?: unknown;
    subtotal?: unknown; tax?: unknown; grand?: unknown; period?: unknown;
  };
  statements: RawStatement[];
  statementLines: RawStatementLine[];
  events: RawEvent[];
  payments: RawPayment[];
}

// ---------------------------------------------------------------------------
// 出力（ひな形へ渡す形。金額は数値と表示用の文字列の両方）
// ---------------------------------------------------------------------------

export interface ReportLine {
  name: string; detail: string | null; dateText: string | null; payOn: string | null;
  quantityStr: string | null; unitStr: string | null; amount: number; amountStr: string;
}
export interface ReportPayment {
  id: number; paymentNo: string | null; dueOn: string | null; paidOn: string | null; status: string;
  net: number; netStr: string;
}
export type PayStatus = "paid" | "partial" | "planned" | "unregistered";
export const PAY_STATUS_LABELS: Record<PayStatus, string> = {
  paid: "支払済", partial: "一部支払済", planned: "支払予定", unregistered: "予定（文書記載）"
};
export interface ReportDoc {
  id: number; index: number; documentNo: string | null; kind: DocKind; kindLabel: string;
  title: string; period: string | null; issuedOn: string | null;
  payOn: string | null; payStatus: PayStatus; statusLabel: string; currency: string;
  amount: number; tax: number; withholding: number; net: number;
  amountStr: string; taxStr: string; withholdingStr: string; netStr: string; hasWithholding: boolean;
  /** 金額の出どころ。payment＝支払の記録／document＝文書の明細（支払がまだ無い）。 */
  amountSource: "payment" | "document";
  dateHeader: string; unitHeader: string;
  lines: ReportLine[]; payments: ReportPayment[];
}
export interface ReportTotal {
  currency: string; count: number; amount: number; tax: number; withholding: number; net: number;
  amountStr: string; taxStr: string; withholdingStr: string; netStr: string;
}
export interface ReportPayDate {
  date: string | null; docs: ReportDoc[]; multiple: boolean;
  amountStr: string; taxStr: string; withholdingStr: string; netStr: string;
}
export interface PaymentReportParty {
  id: number; name: string; kind: "corporate" | "individual"; address: string | null; invoiceNo: string | null;
}
export interface PaymentReportDocument {
  party: PaymentReportParty; from: string; to: string; basis: PaymentReportBasis;
  documents: ReportDoc[]; payDates: ReportPayDate[]; totals: ReportTotal[];
  /** 期間外・除外で載せなかった文書の件数（画面の注記）。 */
  skipped: number;
}

// ---------------------------------------------------------------------------
// 書式
// ---------------------------------------------------------------------------

const MINOR_ONE = new Set(["JPY", "KRW", "VND"]);

/** 最小通貨単位の整数を表示用に（JPY は「¥1,234」、USD は「USD 12.34」）。 */
export function moneyText(amount: number, currency = "JPY"): string {
  const cur = (currency || "JPY").toUpperCase();
  if (MINOR_ONE.has(cur)) {
    const n = new Intl.NumberFormat("ja-JP").format(Math.round(amount));
    return cur === "JPY" ? `¥${n}` : `${cur} ${n}`;
  }
  return `${cur} ${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount / 100)}`;
}

const numText = (value: number | null | undefined): string | null => {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 4 }).format(value);
};

/** 紙の金額の文字列（「¥330,000」「330,000円」「△1,000」）を数に。読めなければ null。 */
export function parseMoneyText(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const s = String(value ?? "").trim();
  if (!s) return null;
  const negative = /^[-−△▲]/.test(s);
  const digits = s.replace(/[^0-9.]/g, "");
  if (!digits) return null;
  const n = Number(digits);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

const toNum = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : parseMoneyText(value);
  return n === null || !Number.isFinite(n) ? null : n;
};

const isoDate = (value: unknown): string | null => {
  const s = String(value ?? "").trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

const compact = (iso: string | null): string | null => iso ? iso.replace(/-/g, "/") : null;

const text = (value: unknown): string | null => {
  const s = String(value ?? "").trim();
  return s ? s : null;
};

const rows = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value) ? value.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [];

// ---------------------------------------------------------------------------
// 明細
// ---------------------------------------------------------------------------

/** 検収書・役務提供完了通知書の明細：紙に刷った行（delivery_line_items・other_fees・expenses）。 */
function inspectionLines(doc: RawDoc, currency: string): ReportLine[] {
  const out: ReportLine[] = [];
  for (const r of rows(doc.rendered.deliveryLines)) {
    const amount = toNum(r.inspected_amount_ex_tax) ?? toNum(r.amount_ex_tax) ?? 0;
    const start = isoDate(r.term_start), end = isoDate(r.term_end);
    const delivered = isoDate(r.delivery_date);
    const quantity = toNum(r.inspected_quantity) ?? toNum(r.quantity);
    const unit = toNum(r.unit_price);
    const orderNo = text(r.order_no);
    const spec = text(r.item_spec) ?? text(r.spec_head);
    out.push({
      name: text(r.item_name) ?? text(r.condition_name) ?? "（品目なし）",
      detail: [spec, orderNo ? `発注番号 ${orderNo}` : null].filter(Boolean).join("　") || null,
      dateText: start && end ? `${compact(start)}〜${compact(end)}` : compact(delivered),
      payOn: isoDate(r.payment_date),
      quantityStr: text(r.sc_hours_text) ?? numText(quantity),
      unitStr: text(r.sc_unit_text) ?? (unit === null ? null : moneyText(unit, currency)),
      amount, amountStr: moneyText(amount, currency)
    });
  }
  for (const r of rows(doc.rendered.otherFees)) {
    const amount = toNum(r.amount_ex_tax) ?? toNum(r.amount) ?? 0;
    out.push({ name: text(r.fee_name) ?? "手数料", detail: text(r.remarks), dateText: null, payOn: null,
               quantityStr: null, unitStr: null, amount, amountStr: moneyText(amount, currency) });
  }
  for (const r of rows(doc.rendered.expenses)) {
    const amount = toNum(r.amount_inc_tax) ?? toNum(r.amount) ?? 0;
    out.push({ name: `${text(r.expense_name) ?? "実費"}（実費・税込）`, detail: text(r.remarks),
               dateText: compact(isoDate(r.spent_date)), payOn: null,
               quantityStr: null, unitStr: null, amount, amountStr: moneyText(amount, currency) });
  }
  return out;
}

/** 計算書の明細（statement_lines）。料率があれば料率、無ければ単価。 */
function statementLines(doc: RawDoc, currency: string): ReportLine[] {
  return doc.statementLines.map((l) => {
    const sales = l.salesInput;
    const qty = l.quantity === null ? null : l.quantity - (l.sampleQuantity ?? 0);
    const detailParts = [
      l.conditionNo ? `条件 ${l.conditionNo}` : null,
      sales !== null ? `算定の基礎 ${moneyText(sales, currency)}` : null,
      l.sampleQuantity ? `見本 ${numText(l.sampleQuantity)} を除く` : null
    ].filter(Boolean);
    return {
      name: l.productName ?? l.conditionName ?? "（品目なし）",
      detail: detailParts.length ? detailParts.join("　") : null,
      dateText: l.period,
      payOn: null,
      quantityStr: numText(qty),
      unitStr: l.ratePpm !== null ? `${(l.ratePpm / 10000).toLocaleString("ja-JP", { maximumFractionDigits: 3 })}%`
        : l.unitAmount !== null ? moneyText(l.unitAmount, currency) : null,
      amount: l.amount, amountStr: moneyText(l.amount, currency)
    };
  });
}

/** 明細が紙にも計算書にも無いとき（V1 から移した文書など）：文書に結びついた実績から。 */
function eventLines(doc: RawDoc, currency: string): ReportLine[] {
  return doc.events.map((e) => ({
    name: e.conditionName ?? "（品目なし）",
    detail: e.conditionNo ? `条件 ${e.conditionNo}` : null,
    dateText: e.period ?? compact(e.occurredOn),
    payOn: null,
    quantityStr: numText(e.quantity),
    unitStr: null,
    amount: e.amount, amountStr: moneyText(e.amount, currency)
  }));
}

// ---------------------------------------------------------------------------
// 文書 1 件
// ---------------------------------------------------------------------------

const currencyOf = (doc: RawDoc): string =>
  (doc.payments[0]?.currency ?? doc.statements[0]?.currency ?? doc.events.find((e) => e.currency)?.currency ?? "JPY").toUpperCase();

/** 支払を文書の割当の割合で按分する（1 件の支払が 2 枚の文書にまたがるとき）。 */
const share = (value: number, p: RawPayment): number =>
  p.allocatedTotal > 0 && p.allocated !== p.allocatedTotal ? Math.round(value * p.allocated / p.allocatedTotal) : value;

export function buildReportDoc(doc: RawDoc): Omit<ReportDoc, "index"> {
  const kind = kindOfKey(doc.templateKey);
  const currency = currencyOf(doc);

  let lines = kind === "statement" ? statementLines(doc, currency) : inspectionLines(doc, currency);
  if (!lines.length) lines = eventLines(doc, currency);
  // 行ごとの支払日（紙に刷った予定日）は、分納で行ごとに違い、支払の記録がまだ無いときだけ出す。
  // 支払があればその日が正（文書の見出しと支払の行に出る）。紙の予定日と並べると食い違って見える。
  const lineDates = new Set(lines.map((l) => l.payOn).filter(Boolean));
  if (doc.payments.length || lineDates.size <= 1) lines = lines.map((l) => ({ ...l, payOn: null }));

  const payments: ReportPayment[] = doc.payments.map((p) => {
    const net = share(p.amount + p.taxAmount - p.withholdingAmount, p);
    return { id: p.id, paymentNo: p.paymentNo, dueOn: p.dueOn, paidOn: p.paidOn, status: p.status,
             net, netStr: moneyText(net, currency) };
  });

  let amount: number, tax: number, withholding: number;
  let amountSource: ReportDoc["amountSource"];
  if (doc.payments.length) {
    amountSource = "payment";
    amount = doc.payments.reduce((s, p) => s + share(p.amount, p), 0);
    tax = doc.payments.reduce((s, p) => s + share(p.taxAmount, p), 0);
    withholding = doc.payments.reduce((s, p) => s + share(p.withholdingAmount, p), 0);
  } else {
    amountSource = "document";
    withholding = 0;
    if (kind === "statement" && doc.statements.length) {
      amount = doc.statements.reduce((s, x) => s + x.netAmount, 0);
      tax = doc.statements.reduce((s, x) => s + x.taxAmount, 0);
    } else {
      const printedSubtotal = parseMoneyText(doc.rendered.subtotal);
      const printedTax = parseMoneyText(doc.rendered.tax);
      amount = printedSubtotal ?? lines.reduce((s, l) => s + l.amount, 0);
      tax = printedTax ?? 0;
      // 実費（税込）は小計の外にある。紙のお支払額が読めれば、そこから差で戻す。
      const grand = parseMoneyText(doc.rendered.grand);
      if (grand !== null && printedSubtotal !== null && printedTax !== null && grand > amount + tax) {
        amount = grand - tax;
      }
    }
  }
  const net = amount + tax - withholding;

  // 支払日：支払があれば支払済みは支払日、未払いは期日（最も遅い日）。無ければ紙の予定日。
  const dates = doc.payments.map((p) => (p.status === "paid" ? p.paidOn ?? p.dueOn : p.dueOn)).filter((d): d is string => !!d);
  const payOn = dates.length ? dates.sort().at(-1)! : doc.printedPayOn;
  const paidCount = doc.payments.filter((p) => p.status === "paid").length;
  const payStatus: PayStatus = !doc.payments.length ? "unregistered"
    : paidCount === doc.payments.length ? "paid" : paidCount ? "partial" : "planned";

  const period = text(doc.rendered.period) ?? (doc.statements.map((s) => s.period).filter(Boolean).join("・") || null);

  return {
    id: doc.id, documentNo: doc.documentNo, kind, kindLabel: KIND_LABELS[kind],
    title: doc.title ?? doc.templateLabel ?? KIND_LABELS[kind], period,
    issuedOn: doc.issuedOn, payOn, payStatus, statusLabel: PAY_STATUS_LABELS[payStatus], currency,
    amount, tax, withholding, net,
    amountStr: moneyText(amount, currency), taxStr: moneyText(tax, currency),
    withholdingStr: moneyText(withholding, currency), netStr: moneyText(net, currency),
    hasWithholding: withholding !== 0, amountSource,
    dateHeader: kind === "statement" ? "対象期間" : "納品日・期間",
    unitHeader: kind === "statement" ? "料率・単価" : "単価（税抜）",
    lines, payments
  };
}

// ---------------------------------------------------------------------------
// 報告書 1 通
// ---------------------------------------------------------------------------

const inRange = (d: string | null, from: string, to: string) => !!d && d >= from && d <= to;

/** 期間の基準でこの文書を載せるか。 */
export function includeDoc(doc: Omit<ReportDoc, "index">, basis: PaymentReportBasis, from: string, to: string): boolean {
  if (basis === "issued") return inRange(doc.issuedOn, from, to);
  if (basis === "paid") {
    if (doc.payStatus !== "paid" && doc.payStatus !== "partial") return false;
    return doc.payments.some((p) => p.status === "paid" && inRange(p.paidOn ?? p.dueOn, from, to));
  }
  return inRange(doc.payOn, from, to);
}

export function buildPaymentReport(input: {
  party: PaymentReportParty; from: string; to: string; basis: PaymentReportBasis;
  docs: RawDoc[]; excludeIds?: number[];
}): PaymentReportDocument {
  const exclude = new Set(input.excludeIds ?? []);
  const built = input.docs.map(buildReportDoc);
  const picked = built.filter((d) => !exclude.has(d.id) && includeDoc(d, input.basis, input.from, input.to));
  // 支払日 → 文書番号 の順。支払日の無いもの（未定）は最後。
  picked.sort((a, b) =>
    (a.payOn ?? "9999-99-99").localeCompare(b.payOn ?? "9999-99-99")
    || String(a.documentNo ?? "").localeCompare(String(b.documentNo ?? "")) || a.id - b.id);
  const documents: ReportDoc[] = picked.map((d, i) => ({ ...d, index: i + 1 }));

  const sum = (docs: ReportDoc[], currency: string) => {
    const xs = docs.filter((d) => d.currency === currency);
    const amount = xs.reduce((s, d) => s + d.amount, 0), tax = xs.reduce((s, d) => s + d.tax, 0);
    const withholding = xs.reduce((s, d) => s + d.withholding, 0), net = xs.reduce((s, d) => s + d.net, 0);
    return { currency, count: xs.length, amount, tax, withholding, net,
             amountStr: moneyText(amount, currency), taxStr: moneyText(tax, currency),
             withholdingStr: moneyText(withholding, currency), netStr: moneyText(net, currency) };
  };

  const currencies = [...new Set(documents.map((d) => d.currency))];
  const totals: ReportTotal[] = currencies.map((c) => sum(documents, c));

  const byDate = new Map<string, ReportDoc[]>();
  for (const d of documents) {
    const key = d.payOn ?? "";
    byDate.set(key, [...(byDate.get(key) ?? []), d]);
  }
  const payDates: ReportPayDate[] = [...byDate.entries()].map(([date, docs]) => {
    // 小計は通貨が 1 つのときだけ意味を持つ。混ざっていれば最初の通貨の分だけ（総計は通貨ごとに出る）。
    const s = sum(docs, docs[0].currency);
    return { date: date || null, docs, multiple: docs.length > 1 && new Set(docs.map((d) => d.currency)).size === 1,
             amountStr: s.amountStr, taxStr: s.taxStr, withholdingStr: s.withholdingStr, netStr: s.netStr };
  });

  return {
    party: input.party, from: input.from, to: input.to, basis: input.basis,
    documents, payDates, totals, skipped: built.length - documents.length
  };
}

/** ひな形（payment_report.html）へ渡す値。 */
export function templateValues(report: PaymentReportDocument, extra: {
  company: Record<string, unknown>; documentDate: string; remarks?: string | null; docNo?: string | null;
}): Record<string, unknown> {
  const kinds = new Set(report.documents.map((d) => d.kind));
  const counts = (["inspection", "completion", "statement"] as DocKind[])
    .map((k) => ({ k, n: report.documents.filter((d) => d.kind === k).length }))
    .filter((x) => x.n > 0);
  const payeeRole = kinds.size === 1 && kinds.has("statement") ? "許諾者"
    : kinds.size && !kinds.has("statement") ? "受注者" : "お支払先";
  const dated = report.payDates.map((p) => p.date).filter((d): d is string => !!d);
  const hasWithholding = report.documents.some((d) => d.hasWithholding);
  const c = extra.company;
  return {
    DOC_NO: extra.docNo ?? "",
    documentDate: extra.documentDate,
    PERIOD_FROM: report.from, PERIOD_TO: report.to, BASIS_LABEL: BASIS_LABELS[report.basis],
    PAYEE_ROLE: payeeRole,
    VENDOR_NAME: report.party.name,
    VENDOR_SUFFIX: report.party.kind === "individual" ? "様" : "御中",
    VENDOR_ADDRESS: report.party.address ?? "",
    INVOICE_REGISTRATION_NUMBER: report.party.invoiceNo ?? "",
    COMPANY_NAME: String(c.name ?? ""), COMPANY_ADDRESS: String(c.address ?? ""),
    COMPANY_POSTAL_CODE: String(c.postalCode ?? ""), COMPANY_INVOICE_NO: String(c.invoiceNo ?? ""),
    COMPANY_TEL: String(c.tel ?? ""),
    docCount: report.documents.length,
    kindSummary: counts.map((x) => `${KIND_LABELS[x.k]} ${x.n} 件`).join("・"),
    payDateCount: dated.length,
    payDateRange: dated.length > 1 ? `${compact(dated[0])} 〜 ${compact(dated.at(-1)!)}` : dated.length ? compact(dated[0]) : "",
    hasWithholding,
    payColspan: hasWithholding ? 8 : 7,
    multiCurrency: report.totals.length > 1,
    payDates: report.payDates,
    totals: report.totals,
    documents: report.documents,
    remarks: extra.remarks ?? ""
  };
}
