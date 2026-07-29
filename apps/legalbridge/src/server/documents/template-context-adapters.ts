import { buildCommonDocumentContext } from "./context-adapter.js";

type Data = Record<string, unknown>;

const GENERATED_VARIABLES: Record<string, string[]> = {
  purchase_order: [
    "BANK_INFO", "DELIVERY_DATE", "REMARKS", "expenses", "expensesTotalIncTax",
    "financial_conditions", "has_license_conditions", "has_performance_incentive",
    "has_seller_owned_license", "items", "order_date", "発行日"
  ],
  intl_purchase_order: [
    "CALC_METHOD", "PAYMENT_TERMS", "REMARKS_FIXED", "REMARKS_FREE",
    "financial_conditions", "has_license_conditions", "has_seller_owned_license",
    "items", "itemsSubtotalExTax"
  ],
  individual_license_terms: [
    "financial_conditions", "work_id", "サブライセンシー一覧", "ライセンス種別名",
    "再許諾補足", "報告トリガー", "報告内容", "報告頻度", "特記事項",
    "監修要否", "税源泉徴収", "素材備考", "素材区分", "見本提供",
    "金銭条件1_MG_AG", "金銭条件1_概要", "金銭条件2_MG_AG",
    "金銭条件2_概要", "金銭条件3_MG_AG", "金銭条件3_概要"
  ],
  royalty_statement: [
    "designerName", "desiredDeadline", "fxRate", "intakeCurrency", "lineGroups",
    "linesTaxStr", "linesTotalIncTaxStr", "linesTotalPaymentStr",
    "linesTotalSalesStr", "payerCompany", "royaltyCategory", "statementMode"
  ],
  inspection_certificate: [
    "changeLogs", "combinedTaxStr", "delivery_line_items", "expenses",
    "expensesTotalIncTaxStr", "grandTotalPayableStr", "hasChangeLogs",
    "hasPerformanceRoyalty", "otherFeesTaxable", "otherFeesTotalStr",
    "other_fees", "performanceRoyaltyLines", "projectTitle",
    "taxableSubtotalExTaxStr", "taxableTotalIncTaxStr"
  ],
  individual_license_terms_v3: ["xxx"]
};

export function isTemplateGeneratedVariable(templateKey: string, variable: string) {
  return GENERATED_VARIABLES[templateKey]?.includes(variable) ?? false;
}

export function buildTemplateDocumentContext(templateKey: string, formData: Data): Data {
  const common: Data = buildCommonDocumentContext(formData);
  if (templateKey === "purchase_order" || templateKey === "intl_purchase_order") {
    return buildPurchaseOrderContext(common);
  }
  if (templateKey === "individual_license_terms") {
    return buildLicenseTermsContext(common);
  }
  if (templateKey === "royalty_statement") {
    return buildRoyaltyStatementContext(common);
  }
  if (templateKey === "inspection_certificate") {
    return buildInspectionContext(common);
  }
  return common;
}

function buildPurchaseOrderContext(source: Data) {
  const items = records(pick(source, "items", "line_items", "order_items"));
  const expenses = records(pick(source, "expenses", "expense_items"));
  const financialConditions = records(pick(
    source, "financial_conditions", "license_financial_conditions"
  ));
  const itemsSubtotalExTax = items.reduce((sum, item) => {
    const amount = number(pick(item, "amount_ex_tax", "amount", "subtotal"));
    return sum + (amount || (
      number(pick(item, "unit_price", "unitPrice")) *
      number(pick(item, "quantity", "qty"), 1)
    ));
  }, 0);
  const expensesTotalIncTax = expenses.reduce((sum, expense) =>
    sum + number(pick(expense, "amount_inc_tax", "amount", "total")), 0);
  const bankInfo = [
    pick(source, "BANK_NAME", "bank_name"),
    pick(source, "BRANCH_NAME", "branch_name"),
    [pick(source, "ACCOUNT_TYPE", "account_type"), pick(source, "ACCOUNT_NUMBER", "account_number")]
      .filter(Boolean).join(" "),
    pick(source, "ACCOUNT_HOLDER_KANA", "account_holder_kana")
  ].filter(Boolean).join(" / ");
  const calcMethods = financialConditions.map((row) =>
    String(pick(row, "calc_method", "CALC_METHOD"))).filter(Boolean);

  return {
    ...source,
    items,
    expenses,
    financial_conditions: financialConditions,
    itemsSubtotalExTax: valueOr(source.itemsSubtotalExTax, itemsSubtotalExTax),
    expensesTotalIncTax: valueOr(source.expensesTotalIncTax, expensesTotalIncTax),
    BANK_INFO: valueOr(source.BANK_INFO, bankInfo),
    DELIVERY_DATE: pick(source, "DELIVERY_DATE", "summaryDeliveryDate", "delivery_date"),
    order_date: pick(source, "order_date", "ORDER_DATE", "発注日"),
    発行日: pick(source, "発行日", "ORDER_DATE", "OF_DATE"),
    REMARKS: pick(source, "REMARKS", "REMARKS_FREE", "SPECIAL_TERMS"),
    REMARKS_FIXED: pick(source, "REMARKS_FIXED", "REMARKS"),
    REMARKS_FREE: pick(source, "REMARKS_FREE", "SPECIAL_TERMS"),
    CALC_METHOD: pick(source, "CALC_METHOD", "calc_method") || calcMethods[0] || "",
    PAYMENT_TERMS: pick(source, "PAYMENT_TERMS", "summaryPaymentTerms", "payment_terms"),
    has_license_conditions: financialConditions.length > 0,
    has_performance_incentive: calcMethods.includes("ROYALTY"),
    has_seller_owned_license:
      toBoolean(source.has_seller_owned_license) ||
      financialConditions.some((row) =>
        ["受注者", "seller", "vendor"].includes(String(pick(row, "rights_holder", "owner")).toLowerCase()))
  };
}

function buildLicenseTermsContext(source: Data) {
  const current = records(source.financial_conditions);
  const financialConditions = current.length ? current : [1, 2, 3]
    .map((index) => legacyFinancialCondition(source, index))
    .filter((row) => Object.entries(row).some(([key, value]) => key !== "condition_no" && Boolean(value)));
  const sublicensees = records(pick(source, "サブライセンシー一覧", "sublicensees"));
  const result: Data = {
    ...source,
    financial_conditions: financialConditions,
    サブライセンシー一覧: sublicensees,
    work_id: pick(source, "work_id", "WORK_ID", "台帳ID"),
    ライセンス種別名: pick(source, "ライセンス種別名", "license_type", "独占性"),
    再許諾補足: pick(source, "再許諾補足", "sublicense_note"),
    報告トリガー: pick(source, "報告トリガー", "reporting_trigger"),
    報告内容: pick(source, "報告内容", "reporting_content"),
    報告頻度: pick(source, "報告頻度", "reporting_frequency"),
    特記事項: pick(source, "特記事項", "特記事項_本文", "SPECIAL_TERMS"),
    監修要否: pick(source, "監修要否", "approval_required"),
    税源泉徴収: pick(source, "税源泉徴収", "withholding_tax"),
    素材備考: pick(source, "素材備考", "material_note"),
    素材区分: pick(source, "素材区分", "material_type"),
    見本提供: pick(source, "見本提供", "sample_copy")
  };
  financialConditions.slice(0, 3).forEach((condition, offset) => {
    const index = offset + 1;
    result[`金銭条件${index}_MG_AG`] = pick(
      source, `金銭条件${index}_MG_AG`
    ) || moneySummary(condition);
    result[`金銭条件${index}_概要`] = pick(
      source, `金銭条件${index}_概要`
    ) || conditionSummary(condition);
  });
  return result;
}

function buildRoyaltyStatementContext(source: Data) {
  const groups = records(source.lineGroups);
  const lines = records(pick(source, "lines", "royalty_lines"));
  const lineGroups = groups.length ? groups : lines.length ? [{
    contractTitle: pick(source, "contractTitle", "CONTRACT_TITLE"),
    contractNumber: pick(source, "linked_contract_number", "CONTRACT_NO"),
    methodLabel: pick(source, "methodLabel", "royaltyCategory"),
    lines
  }] : [];
  const flatLines = lineGroups.flatMap((group) => records(group.lines));
  const totalSales = flatLines.reduce((sum, line) =>
    sum + number(pick(line, "salesJpy", "sales", "sales_amount", "base_amount")), 0);
  const totalPayment = flatLines.reduce((sum, line) =>
    sum + number(pick(line, "paymentJpy", "payment", "payment_amount", "royalty_amount")), 0);
  const taxRate = number(pick(source, "taxRate", "tax_rate"), 10);
  const tax = Math.ceil(totalPayment * taxRate / 100);
  return {
    ...source,
    statementMode: valueOr(source.statementMode, lineGroups.length > 1 ? "multi" : "single"),
    lineGroups,
    payerCompany: pick(source, "payerCompany", "licensee", "PARTY_A_NAME"),
    royaltyCategory: pick(source, "royaltyCategory", "CALC_METHOD", "category"),
    designerName: pick(source, "designerName", "licensor", "VENDOR_NAME"),
    desiredDeadline: pick(source, "desiredDeadline", "paymentDueDate", "PAYMENT_DATE"),
    intakeCurrency: pick(source, "intakeCurrency", "currency", "CURRENCY") || "JPY",
    fxRate: pick(source, "fxRate", "exchange_rate"),
    linesTotalSalesStr: valueOr(source.linesTotalSalesStr, yen(totalSales)),
    linesTotalPaymentStr: valueOr(source.linesTotalPaymentStr, yen(totalPayment)),
    linesTaxStr: valueOr(source.linesTaxStr, yen(tax)),
    linesTotalIncTaxStr: valueOr(source.linesTotalIncTaxStr, yen(totalPayment + tax))
  };
}

function buildInspectionContext(source: Data) {
  const deliveryLines = records(pick(source, "delivery_line_items", "items", "line_items"));
  const expenses = records(source.expenses);
  const otherFees = records(source.other_fees);
  const changeLogs = records(source.changeLogs).length
    ? records(source.changeLogs)
    : parseChangeLogs(source.CHANGE_RECORDS);
  const deliveredExTax = deliveryLines.reduce((sum, line) =>
    sum + number(pick(line, "inspected_amount_ex_tax", "amount_ex_tax", "amount")), 0);
  const otherFeesExTax = otherFees.reduce((sum, fee) =>
    sum + number(pick(fee, "amount_ex_tax", "amount")), 0);
  const expensesIncTax = expenses.reduce((sum, expense) =>
    sum + number(pick(expense, "amount_inc_tax", "amount")), 0);
  const taxRate = number(pick(source, "taxRate", "tax_rate"), 10);
  const taxableSubtotal = deliveredExTax + otherFeesExTax;
  const combinedTax = Math.ceil(taxableSubtotal * taxRate / 100);
  const taxableTotal = taxableSubtotal + combinedTax;
  const performanceRoyaltyLines = deliveryLines.filter((line) =>
    String(pick(line, "calc_method", "CALC_METHOD")).toUpperCase() === "ROYALTY");
  return {
    ...source,
    delivery_line_items: deliveryLines,
    expenses,
    other_fees: otherFees,
    changeLogs,
    hasChangeLogs: changeLogs.length > 0,
    hasPerformanceRoyalty: performanceRoyaltyLines.length > 0,
    performanceRoyaltyLines,
    otherFeesTaxable: otherFeesExTax > 0,
    projectTitle: pick(source, "projectTitle", "PROJECT_TITLE", "subject"),
    otherFeesTotalStr: valueOr(source.otherFeesTotalStr, yen(otherFeesExTax)),
    taxableSubtotalExTaxStr: valueOr(source.taxableSubtotalExTaxStr, yen(taxableSubtotal)),
    combinedTaxStr: valueOr(source.combinedTaxStr, yen(combinedTax)),
    taxableTotalIncTaxStr: valueOr(source.taxableTotalIncTaxStr, yen(taxableTotal)),
    expensesTotalIncTaxStr: valueOr(source.expensesTotalIncTaxStr, yen(expensesIncTax)),
    grandTotalPayableStr: valueOr(source.grandTotalPayableStr, yen(taxableTotal + expensesIncTax))
  };
}

function legacyFinancialCondition(source: Data, index: number): Data {
  const prefix = `金銭条件${index}_`;
  return {
    condition_no: index,
    region_language_label: source[`${prefix}地域言語ラベル`] ?? "",
    calc_method: source[`${prefix}計算方式`] ?? "",
    rate_pct: source[`${prefix}料率`] ?? "",
    base_price_label: source[`${prefix}基準価格ラベル`] ?? "",
    calc_period: source[`${prefix}計算期間`] ?? "",
    currency: source[`${prefix}通貨`] ?? "",
    formula_text: source[`${prefix}計算式`] ?? "",
    payment_terms: source[`${prefix}支払条件`] ?? ""
  };
}

function conditionSummary(condition: Data) {
  return [
    pick(condition, "region_language_label", "condition_name"),
    pick(condition, "calc_method"),
    pick(condition, "base_price_label"),
    pick(condition, "rate_pct") ? `${pick(condition, "rate_pct")}%` : "",
    pick(condition, "formula_text")
  ].filter(Boolean).join(" / ");
}

function moneySummary(condition: Data) {
  const mg = number(pick(condition, "mg_amount", "MG"));
  const ag = number(pick(condition, "ag_amount", "AG"));
  return [mg ? `MG ${yen(mg)}` : "", ag ? `AG ${yen(ag)}` : ""].filter(Boolean).join(" / ");
}

function parseChangeLogs(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return [];
  return value.split(";").filter(Boolean).map((entry) => {
    const [changedAt, fieldLabel, beforeValue, afterValue, reason] = entry.split("|");
    return { changedAt, fieldLabel, beforeValue, afterValue, reason };
  });
}

function records(value: unknown): Data[] {
  return Array.isArray(value)
    ? value.filter((item): item is Data => !!item && typeof item === "object" && !Array.isArray(item))
    : [];
}

function pick(source: Data, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return "";
}

function number(value: unknown, fallback = 0) {
  const parsed = Number.parseFloat(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function yen(value: number) {
  return Math.round(value).toLocaleString("ja-JP");
}

function valueOr(value: unknown, fallback: unknown) {
  return value !== undefined && value !== null && String(value).trim() !== "" ? value : fallback;
}

function toBoolean(value: unknown) {
  if (typeof value === "boolean") return value;
  return ["true", "1", "yes", "on", "該当"].includes(String(value ?? "").trim().toLowerCase());
}
