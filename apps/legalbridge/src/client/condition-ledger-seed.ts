// 条件台帳 → 文書作成フォームの初期値（純関数・2026-09-04）。
//
// ③「新規文書に紐づける」で従来の文書作成フォームへ引き渡す form_data を組む。
// 条件部分は台帳の行を引用し、条件明細キー（CL-…）と台帳の番号（CT-…）を持たせる。
// 確定時はサーバが form_data.condition_ledger_id を見て条件同期をスキップし、
// 文書を台帳へ紐づけるだけ＝条件明細が二重にならない。

import type { DocumentFormData } from "../types";
import {
  groupRateSums, joinNames, taxRateFor, type ConditionLedgerPayload, type LedgerLicenseRow
} from "../condition-ledger";
import { fixedDealRows } from "./work-intake";

export interface LedgerRef { id: number; documentNumber: string; lineCodes?: Record<number, string> }

const yen = (v: number | null) => (v == null ? "" : String(v));

function licenseFinancialConditions(rows: LedgerLicenseRow[], startNo: number, codes: Record<number, string> | undefined, base: number) {
  return rows.map((row, i) => ({
    condition_no: startNo + i,
    condition_name: row.name,
    material_code: row.materialCode,
    group_no: row.groupNo ?? "",
    is_addon: row.groupNo != null,
    calc_method: "ROYALTY",
    calc_type: "BASE_QTY_RATE",
    rate_pct: yen(row.ratePct),
    base_price_label: row.basePriceLabel,
    guarantee_type: row.agAmount ? "AG" : row.mgAmount ? "MG" : "NONE",
    mg_amount: yen(row.mgAmount), ag_amount: yen(row.agAmount),
    currency: "JPY",
    region_territory: joinNames(row.regions), region_language: joinNames(row.languages),
    region_language_label: [joinNames(row.regions), joinNames(row.languages)].filter(Boolean).join("／"),
    regions: row.regions, languages: row.languages,
    payment_terms: row.paymentTerms,
    ...(codes?.[base + i + 1] ? { condition_line_code: codes[base + i + 1] } : {})
  }));
}

/**
 * テンプレート別の初期値。相手先・作品の欄（振込口座・許諾者名など）は呼び出し側が
 * buildPatch（DBから引用）で重ねる。ここは条件と台帳キーだけを扱う。
 */
export function ledgerToFormSeed(payload: ConditionLedgerPayload, templateKey: string, ledger: LedgerRef): DocumentFormData {
  const codes = ledger.lineCodes;
  const common: DocumentFormData = {
    condition_ledger_id: String(ledger.id),
    condition_ledger_number: ledger.documentNumber,
    counterparty: payload.vendorName,
    ...(payload.workCode ? { work_code: payload.workCode } : {}),
    flow_direction: templateKey === "license_out_en" ? "out" : "in"
  };
  const service = payload.kinds.includes("service");
  const lin = payload.kinds.includes("license_in");
  const lout = payload.kinds.includes("license_out");

  if (templateKey === "purchase_order" || templateKey === "intl_purchase_order") {
    const items = service ? payload.payments.map((row, i) => ({
      line_no: i + 1,
      item_name: row.name,
      spec: row.materialCode ? `対象素材: ${row.materialCode}` : "",
      quantity: "1", unit_price: yen(row.amountExTax), amount_ex_tax: yen(row.amountExTax),
      payment_terms: row.paymentTerms,
      calc_method: row.scheme === "subscription" ? "SUBSCRIPTION" : "FIXED",
      ...(row.scheme === "installment" ? { calc_type: "FIXED", fixed_kind: "INSTALLMENT" } : {}),
      ...(row.deliverableOwnership ? { deliverable_ownership: row.deliverableOwnership } : {}),
      ...(codes?.[1000 + i + 1] ? { condition_line_code: codes[1000 + i + 1] } : {})
    })) : [];
    const expenses = service ? payload.expenses.map((row, i) => ({
      line_no: i + 1, expense_name: row.name,
      // 発注書・検収書の経費欄は税込。税区分から税込へ換算し、区分もそのまま持たせる（経理エクセル用）。
      amount_inc_tax: row.amountExTax == null ? "" : String(Math.round(row.amountExTax * (1 + taxRateFor(row.taxCategory)))),
      amount_ex_tax: yen(row.amountExTax), tax_category: row.taxCategory, remarks: row.settlement,
      ...(codes?.[2000 + i + 1] ? { condition_line_code: codes[2000 + i + 1] } : {})
    })) : [];
    const otherFees = service ? payload.fees.map((row, i) => ({
      line_no: i + 1, fee_name: row.name, amount: yen(row.amountExTax), tax_category: row.taxCategory, remarks: row.notes,
      ...(codes?.[3000 + i + 1] ? { condition_line_code: codes[3000 + i + 1] } : {})
    })) : [];
    return {
      ...common,
      ...(items.length ? { items } : {}),
      ...(expenses.length ? { expenses } : {}),
      ...(otherFees.length ? { other_fees: otherFees } : {}),
      ...(lin && payload.licenseIn.length ? { financial_conditions: licenseFinancialConditions(payload.licenseIn, 1, codes, 5000) } : {})
    };
  }

  if (templateKey === "individual_license_terms_v3") {
    // 料率行 → 構成要素（v3_lcs）。取引形態は固定3種、料率は取引形態1（自社製造・自社販売）に入れる。
    const deals = fixedDealRows();
    const mgTotal = payload.licenseIn.reduce((s, r) => s + (r.mgAmount ?? 0), 0);
    const agTotal = payload.licenseIn.reduce((s, r) => s + (r.agAmount ?? 0), 0);
    if (mgTotal > 0) deals[0].mg = String(mgTotal);
    if (agTotal > 0) deals[0].ag = String(agTotal);
    const first = payload.licenseIn[0];
    if (first) {
      deals[0].reg = joinNames(first.regions) || "全世界";
      deals[0].lang = joinNames(first.languages) || "全言語";
    }
    return {
      ...common,
      work_id: payload.workCode ?? "",
      ...(payload.workTitle ? { 対象製品予定名: payload.workTitle } : {}),
      ...(payload.vendorName ? { Licensor_氏名会社名: payload.vendorName } : {}),
      v3_conds: deals,
      v3_lcs: payload.licenseIn.map((row, i) => ({
        material_code: row.materialCode, name: row.name, holder: payload.vendorName,
        region: joinNames(row.regions), language: joinNames(row.languages),
        rates: row.ratePct != null ? { "1": String(row.ratePct) } : {},
        ...(codes?.[5000 + i + 1] ? { condition_line_code: codes[5000 + i + 1] } : {})
      }))
    };
  }

  if (templateKey === "license_out_en") {
    // テンプレ 050 の変数名: GAME_TITLE（原題）/ TERRITORIES（A.2）/ LANGUAGE_VERSIONS（A.3）/
    // LICENSE_FEE（A.6・料率と基準を英文で）/ ADVANCE_PAYMENT（A.7・前払金＝MG/AG）/ LICENSEE_NAME。
    const rows = lout ? payload.licenseOut : [];
    const sums = groupRateSums(rows);
    const first = rows[0];
    const rate = first ? (first.ratePct ?? Object.values(sums)[0] ?? null) : null;
    const advance = first ? (first.agAmount || first.mgAmount || null) : null;
    return {
      ...common,
      ...(payload.vendorName ? { LICENSEE_NAME: payload.vendorName } : {}),
      ...(payload.workTitle ? { GAME_TITLE: payload.workTitle } : {}),
      ...(first ? {
        TERRITORIES: joinNames(first.regions, " / "),
        LANGUAGE_VERSIONS: joinNames(first.languages, " / "),
        ...(rate != null ? { LICENSE_FEE: `${rate}% of the ${first.basePriceLabel || "net sales"}` } : {}),
        ...(advance != null ? { ADVANCE_PAYMENT: `JPY ${advance.toLocaleString("en-US")}` } : {})
      } : {}),
      ...(rows.length ? { financial_conditions: licenseFinancialConditions(rows, 1, codes, 6000) } : {})
    };
  }

  // 出版個別利用許諾条件書（pub_license_terms）ほか：原著作物名・紙書籍印税率は料率行の先頭から。
  // 条件の全量は金銭条件（financial_conditions）として渡し、テンプレ固有の欄はフォーム側で確認して埋める。
  const firstIn = lin ? payload.licenseIn[0] : undefined;
  return {
    ...common,
    ...(payload.workTitle ? { 原著作物名: payload.workTitle } : {}),
    ...(templateKey === "pub_license_terms" && firstIn?.ratePct != null ? { 紙書籍印税率: String(firstIn.ratePct) } : {}),
    ...(lin && payload.licenseIn.length ? { financial_conditions: licenseFinancialConditions(payload.licenseIn, 1, codes, 5000) } : {})
  };
}

/**
 * 検収書の「親の発注書から引用」に渡す発注書の値。フォームで作った発注書は items/expenses/other_fees
 * を持つが、アップロードした過去の発注書（取込）は持たない。条件台帳に紐づいていれば、台帳の
 * 支払・経費・手数料から同じ形の明細を組み立てて補う（条件明細キー・税区分付き）。
 */
export function purchaseOrderValuesForInspection(
  document: { id: number; documentNumber: string | null; templateType: string; formData: Record<string, unknown> },
  ledger: { payload: ConditionLedgerPayload; id: number; documentNumber: string; lineCodes?: Record<number, string> } | null
): Record<string, unknown> {
  const values: Record<string, unknown> = {
    ...document.formData, template_type: document.templateType, document_number: document.documentNumber ?? ""
  };
  const hasItems = Array.isArray(values.items) && (values.items as unknown[]).length > 0;
  if (!hasItems && ledger) {
    const seed = ledgerToFormSeed(ledger.payload, "purchase_order", ledger);
    if (seed.items) values.items = seed.items;
    if (!Array.isArray(values.expenses) || !(values.expenses as unknown[]).length) { if (seed.expenses) values.expenses = seed.expenses; }
    if (!Array.isArray(values.other_fees) || !(values.other_fees as unknown[]).length) { if (seed.other_fees) values.other_fees = seed.other_fees; }
    if (!values.counterparty && ledger.payload.vendorName) values.counterparty = ledger.payload.vendorName;
    if (!values.PROJECT_TITLE && !values.title && ledger.payload.title) values.title = ledger.payload.title;
  }
  return values;
}
