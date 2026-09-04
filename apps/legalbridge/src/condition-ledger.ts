// 条件台帳（condition_ledger・2026-09-04）— クライアントとサーバで共有する純関数部。
//
// 「条件明細を正にする」新フローの入力（payload）と、その台帳（condition_lines）への
// 変換を定義する。文書は最後の出力先であり、ここで作った条件明細を引用して従来の
// 文書作成フォームで作るか、既存／アップロード文書に紐づける。確定時に条件明細を
// 作り直さない（＝二重にならない）ための唯一の変換点なので、ここ以外で台帳行を
// 組み立てない。
//
// 台帳の入れ物（anchor）: documents 行 template_type='condition_ledger'（印刷しない
// 台帳レコード・番号 CT-YYYY-NNNNN）。condition_lines.document_id はこの行を指す。
// 契約ヘッダ（contracts）は補助的に作り、documents.contract_id で結ぶ。

import type { ConditionSyncInput } from "./server/documents/condition-sync.js";

export type LedgerKind = "service" | "license_in" | "license_out";
export type LedgerStatus = "draft" | "final";
export type TaxCategory = "taxable" | "reduced" | "exempt";
export type PaymentScheme = "lump_sum" | "installment" | "subscription" | "per_unit";

export interface CodedName { code: string | null; name: string }

export interface LedgerPaymentRow {
  scheme: PaymentScheme;
  materialCode: string;       // 空＝成果物・素材を特定しない
  name: string;
  amountExTax: number | null;
  paymentTerms: string;       // 支払時期（納品月の翌月末 等）
  deliverableOwnership?: string; // 発注者／受注者（発注書の成果物帰属）
}
export interface LedgerExpenseRow {
  name: string;
  amountExTax: number | null;
  taxCategory: TaxCategory;
  settlement: string;         // 実費精算（領収書）／定額／上限あり
}
export interface LedgerFeeRow {
  name: string;
  amountExTax: number | null;
  taxCategory: TaxCategory;
  notes: string;
}
export interface LedgerLicenseRow {
  materialCode: string;       // 空＝文書全体
  name: string;
  ratePct: number | null;
  mgAmount: number | null;
  agAmount: number | null;
  groupNo: number | null;     // 加算型の束ね（同じ番号でΣが適用料率）
  regions: CodedName[];       // 許諾地域（国コード・名）
  languages: CodedName[];     // 許諾言語（言語コード・名）
  basePriceLabel: string;
  paymentTerms: string;
}

export interface ConditionLedgerPayload {
  entry: "new" | "work";
  workId: number | null;
  workCode: string | null;
  workTitle: string;
  vendorId: number | null;
  vendorName: string;
  title: string;              // 契約名（例: 「エピローグ」イラスト制作・原作許諾）
  termStart: string;          // YYYY-MM-DD or ""
  termEnd: string;
  kinds: LedgerKind[];
  payments: LedgerPaymentRow[];
  expenses: LedgerExpenseRow[];
  fees: LedgerFeeRow[];
  licenseIn: LedgerLicenseRow[];
  licenseOut: LedgerLicenseRow[];
  status: LedgerStatus;
  notes: string;
}

export const TAX_CATEGORY_OPTIONS: Array<{ value: TaxCategory; label: string; rate: number }> = [
  { value: "taxable", label: "課税対象（10%）", rate: 0.10 },
  { value: "reduced", label: "課税対象（8%）", rate: 0.08 },
  { value: "exempt", label: "非課税・不課税", rate: 0 }
];
export const PAYMENT_SCHEME_OPTIONS: Array<{ value: PaymentScheme; label: string }> = [
  { value: "lump_sum", label: "固定額（一時金）" },
  { value: "installment", label: "分割払い" },
  { value: "subscription", label: "サブスク（定期）" },
  { value: "per_unit", label: "単価×数量（供給）" }
];
export const LEDGER_KIND_OPTIONS: Array<{ value: LedgerKind; label: string; hint: string }> = [
  { value: "service", label: "業務委託用", hint: "支払（固定額・分割・サブスク・供給）＋経費＋その他手数料。課税／非課税を持つ" },
  { value: "license_in", label: "利用許諾 イン（許諾を受ける）", hint: "当社が支払う料率・MG/AG。許諾地域・言語は複数選択" },
  { value: "license_out", label: "利用許諾 アウト（許諾する）", hint: "当社が受け取る料率・MG/AG。許諾地域・言語は複数選択" }
];

export function taxCategoryLabel(value: string | null | undefined): string {
  return TAX_CATEGORY_OPTIONS.find((o) => o.value === value)?.label ?? "—";
}
export function taxRateFor(value: TaxCategory | string | null | undefined): number {
  return TAX_CATEGORY_OPTIONS.find((o) => o.value === value)?.rate ?? 0;
}

export function emptyLedgerPayload(): ConditionLedgerPayload {
  return {
    entry: "new", workId: null, workCode: null, workTitle: "", vendorId: null, vendorName: "",
    title: "", termStart: "", termEnd: "", kinds: ["service"],
    payments: [], expenses: [], fees: [], licenseIn: [], licenseOut: [],
    status: "draft", notes: ""
  };
}
export function emptyPaymentRow(): LedgerPaymentRow {
  return { scheme: "lump_sum", materialCode: "", name: "", amountExTax: null, paymentTerms: "" };
}
// 既定の税区分（2026-09-04 利用者確認）: 経費＝非課税・不課税（立替・実費）、その他手数料＝課税対象。
// 行ごとに変更できる。
export function emptyExpenseRow(): LedgerExpenseRow {
  return { name: "", amountExTax: null, taxCategory: "exempt", settlement: "実費精算（領収書）" };
}
export function emptyFeeRow(): LedgerFeeRow {
  return { name: "", amountExTax: null, taxCategory: "taxable", notes: "" };
}
export function emptyLicenseRow(): LedgerLicenseRow {
  return {
    materialCode: "", name: "", ratePct: null, mgAmount: null, agAmount: null, groupNo: null,
    regions: [{ code: null, name: "全世界" }], languages: [{ code: null, name: "全言語" }],
    basePriceLabel: "", paymentTerms: ""
  };
}

const amt = (v: number | null | undefined): number => (v != null && Number.isFinite(v) ? v : 0);

/** 業務委託の税区分別集計（発注書の税計算と経理提出用エクセルの列がそのまま出る）。 */
export interface LedgerTaxSummary {
  taxable: number;   // 課税対象（10%）の税抜合計（支払行＋課税の経費・手数料）
  reduced: number;   // 課税対象（8%）
  exempt: number;    // 非課税・不課税
  tax: number;       // 消費税
  total: number;     // 税込合計
}
export function ledgerTaxSummary(payload: Pick<ConditionLedgerPayload, "kinds" | "payments" | "expenses" | "fees">): LedgerTaxSummary {
  if (!payload.kinds.includes("service")) return { taxable: 0, reduced: 0, exempt: 0, tax: 0, total: 0 };
  const settlement = [...payload.expenses, ...payload.fees];
  const sum = (rows: Array<{ amountExTax: number | null }>) => rows.reduce((s, r) => s + amt(r.amountExTax), 0);
  const taxable = sum(payload.payments) + sum(settlement.filter((r) => r.taxCategory === "taxable"));
  const reduced = sum(settlement.filter((r) => r.taxCategory === "reduced"));
  const exempt = sum(settlement.filter((r) => r.taxCategory === "exempt"));
  const tax = Math.round(taxable * 0.10) + Math.round(reduced * 0.08);
  return { taxable, reduced, exempt, tax, total: taxable + reduced + exempt + tax };
}

/** 許諾地域・言語の表現（条件書・契約の Territory/Language 欄にそのまま差し込む）。 */
export function joinNames(items: CodedName[], separator = "・"): string {
  return items.map((i) => i.name.trim()).filter(Boolean).join(separator);
}

/** 加算型（同じグループ番号）の適用料率Σ。 */
export function groupRateSums(rows: LedgerLicenseRow[]): Record<string, number> {
  const sums: Record<string, number> = {};
  rows.forEach((r) => {
    if (r.groupNo == null) return;
    sums[String(r.groupNo)] = (sums[String(r.groupNo)] ?? 0) + amt(r.ratePct);
  });
  return sums;
}

// line_no の帯（同じ anchor 文書内で種類ごとに非衝突）。
const LINE_BASE = { payment: 1000, expense: 2000, fee: 3000, license_in: 5000, license_out: 6000 } as const;

/**
 * 台帳 payload → condition_lines 入力（置換 upsert 用の全量）。
 *   業務委託: 支払行＝lump_sum/installment/subscription/per_unit（transaction_kind=service）、
 *            経費・手数料＝lump_sum＋line_kind＋tax_category（同 service）。
 *   利用許諾: royalty 行（transaction_kind=license）。イン＝payable／アウト＝receivable。
 *            許諾地域・言語は子テーブル（regions/languages）に code+name で保存。
 */
export function ledgerToConditionInputs(payload: ConditionLedgerPayload): ConditionSyncInput[] {
  const out: ConditionSyncInput[] = [];
  const vendor = payload.vendorId ?? null;
  const term = { term_start: payload.termStart || null, term_end: payload.termEnd || null };
  const hasKind = (k: LedgerKind) => payload.kinds.includes(k);

  if (hasKind("service")) {
    payload.payments.forEach((row, i) => {
      out.push({
        line_no: LINE_BASE.payment + i + 1, direction: "payable", is_addon: false,
        payment_scheme: row.scheme, transaction_kind: "service", line_kind: "payment",
        material_code: row.materialCode || null, condition_name: row.name || null,
        amount_ex_tax: row.amountExTax, currency: "JPY", payment_terms: row.paymentTerms || null,
        tax_category: "taxable", counterparty_vendor_id: vendor, ...term
      });
    });
    payload.expenses.forEach((row, i) => {
      out.push({
        line_no: LINE_BASE.expense + i + 1, direction: "payable", is_addon: false,
        payment_scheme: "lump_sum", transaction_kind: "service", line_kind: "expense",
        condition_name: row.name || null, amount_ex_tax: row.amountExTax, currency: "JPY",
        tax_category: row.taxCategory, notes: row.settlement || null,
        counterparty_vendor_id: vendor, ...term
      });
    });
    payload.fees.forEach((row, i) => {
      out.push({
        line_no: LINE_BASE.fee + i + 1, direction: "payable", is_addon: false,
        payment_scheme: "lump_sum", transaction_kind: "service", line_kind: "fee",
        condition_name: row.name || null, amount_ex_tax: row.amountExTax, currency: "JPY",
        tax_category: row.taxCategory, notes: row.notes || null,
        counterparty_vendor_id: vendor, ...term
      });
    });
  }
  const license = (rows: LedgerLicenseRow[], direction: "payable" | "receivable", base: number) => {
    rows.forEach((row, i) => {
      out.push({
        line_no: base + i + 1, direction, is_addon: row.groupNo != null,
        group_no: row.groupNo, payment_scheme: "royalty", transaction_kind: "license",
        material_code: row.materialCode || null, condition_name: row.name || null,
        rate_pct: row.ratePct, mg_amount: row.mgAmount, ag_amount: row.agAmount,
        currency: "JPY", base_price_label: row.basePriceLabel || null,
        payment_terms: row.paymentTerms || null,
        region_territory: joinNames(row.regions) || null, region_language: joinNames(row.languages) || null,
        regions: row.regions.filter((r) => r.name.trim()),
        languages: row.languages.filter((l) => l.name.trim()),
        counterparty_vendor_id: vendor, ...term
      });
    });
  };
  if (hasKind("license_in")) license(payload.licenseIn, "payable", LINE_BASE.license_in);
  if (hasKind("license_out")) license(payload.licenseOut, "receivable", LINE_BASE.license_out);
  return out;
}

/** 台帳の向き（anchor 文書の flow_direction 表示用）。イン・アウト両方なら "both"。 */
export function ledgerFlow(payload: Pick<ConditionLedgerPayload, "kinds">): "in" | "out" | "both" {
  const hasIn = payload.kinds.includes("service") || payload.kinds.includes("license_in");
  const hasOut = payload.kinds.includes("license_out");
  return hasIn && hasOut ? "both" : hasOut ? "out" : "in";
}

/** ②の内容から作れる文書（③「新規文書に紐づける」の候補・作れない理由つき）。 */
export interface LedgerDocumentChoice {
  templateKey: "purchase_order" | "individual_license_terms_v3" | "pub_license_terms" | "license_out_en";
  label: string;
  hint: string;
  blockedReason: string | null;
}
export function ledgerDocumentChoices(
  payload: Pick<ConditionLedgerPayload, "kinds" | "payments" | "licenseIn" | "licenseOut">,
  businessLine: string | null | undefined
): LedgerDocumentChoice[] {
  const service = payload.kinds.includes("service");
  const lin = payload.kinds.includes("license_in");
  const lout = payload.kinds.includes("license_out");
  const choices: LedgerDocumentChoice[] = [{
    templateKey: "purchase_order", label: "発注書",
    hint: lin ? "支払・経費・手数料を明細に引用。利用許諾インの料率も同じ発注書の「利用許諾・業績連動条件」へ"
      : "支払・経費・手数料を発注明細に引用（条件明細キー・税区分付き）",
    blockedReason: !service ? "業務委託の条件明細が必要" : !payload.payments.length ? "支払行が必要" : null
  }];
  const licBlocked = !lin ? "利用許諾インの条件明細が必要" : !payload.licenseIn.length ? "料率行が必要" : null;
  if (businessLine !== "publishing") {
    choices.push({
      templateKey: "individual_license_terms_v3", label: "個別利用許諾条件書（ゲーム）",
      hint: "料率行を取引形態×構成要素のマトリクスに展開。許諾地域・言語も差し込み", blockedReason: licBlocked
    });
  }
  if (businessLine === "publishing" || businessLine === "both" || businessLine == null) {
    choices.push({
      templateKey: "pub_license_terms", label: "出版個別利用許諾条件書",
      hint: "許諾者へ支払う印税（イン条件）。料率・MG/AG・許諾地域を差し込み", blockedReason: licBlocked
    });
  }
  choices.push({
    templateKey: "license_out_en", label: "ライセンスアウト契約（英文）",
    hint: "受け取る料率・MG・Territory/Language を差し込み",
    blockedReason: !lout ? "利用許諾アウトの条件明細が必要" : !payload.licenseOut.length ? "料率行が必要" : null
  });
  return choices;
}
