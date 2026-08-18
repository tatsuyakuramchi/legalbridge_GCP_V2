import { buildCommonDocumentContext } from "./context-adapter.js";
import { computeInspectionTotals, inspectionLineStatus } from "../../inspection-totals.js";
import { aggregateItemDates, purchaseOrderTotals } from "../../purchase-order-totals.js";
import { buildMultiStatementPatch, buildSingleStatementPatch } from "../../royalty-statement.js";

type Data = Record<string, unknown>;

const GENERATED_VARIABLES: Record<string, string[]> = {
  purchase_order: [
    "BANK_INFO", "DELIVERY_DATE", "REMARKS", "expenses", "expensesTotalIncTax",
    "financial_conditions", "has_license_conditions", "has_performance_incentive",
    "has_seller_owned_license", "items", "order_date", "発行日",
    "other_fees", "otherFeesTotal", "summaryDeliveryDate", "summaryPaymentDate"
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
    "linesTotalSalesStr", "payerCompany", "royaltyCategory", "statementMode",
    // 構造化入力（rs*）から計算エンジンで組み立てる変数（V1 onPreview パッチ相当）
    "actualRoyalty", "actualRoyaltyStr", "agAmountStr", "agApplied",
    "agConsumedAfterStr", "agConsumedBeforeStr", "agConsumedThisTimeStr",
    "agFullyConsumed", "agProgressPct", "agRemainingStr", "billableQuantity",
    "calcType", "grossRoyaltyStr", "mgAmountStr", "mgTopupApplied",
    "mgTopupThisTimeStr", "msrpStr", "receiptRows", "taxAmount", "totalPaymentStr"
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
  const otherFees = records(pick(source, "other_fees", "otherFees"));
  // 合計はクライアントと同じ純関数で出す（画面の合計と PDF の合計を必ず一致させる）。
  const totals = purchaseOrderTotals({ items, other_fees: otherFees });
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
  // 明細に業績連動行があれば、金銭条件表が空でも条件表を出す。テンプレートは
  // financial_conditions が空のとき ROYALTY 明細を条件表へ流し込む分岐を持つが、
  // has_license_conditions が条件表の件数だけを見ていたためその分岐に入れなかった。
  const royaltyItems = items.filter((item) =>
    String(pick(item, "calc_method", "CALC_METHOD")).toUpperCase() === "ROYALTY");

  return {
    ...source,
    items,
    expenses,
    financial_conditions: financialConditions,
    other_fees: otherFees,
    itemsSubtotalExTax: totals.itemsSubtotalExTax,
    otherFeesTotal: totals.otherFeesTotal,
    // 明細も手数料も無い発注書は合計金額を手入力する運用が残っているので、
    // 行が1つも無いときだけ入力値を尊重する（行があるのに手入力が勝つと画面とずれる）。
    grandTotalExTax: items.length || otherFees.length
      ? totals.grandTotalExTax
      : number(pick(source, "grandTotalExTax")),
    expensesTotalIncTax: valueOr(source.expensesTotalIncTax, expensesTotalIncTax),
    BANK_INFO: valueOr(source.BANK_INFO, bankInfo),
    summaryDeliveryDate: valueOr(source.summaryDeliveryDate, aggregateItemDates(items, "delivery_date")),
    summaryPaymentDate: valueOr(source.summaryPaymentDate, aggregateItemDates(items, "payment_date")),
    DELIVERY_DATE: pick(source, "DELIVERY_DATE", "summaryDeliveryDate", "delivery_date")
      || aggregateItemDates(items, "delivery_date"),
    order_date: pick(source, "order_date", "ORDER_DATE", "発注日"),
    発行日: pick(source, "発行日", "ORDER_DATE", "OF_DATE"),
    // 特約事項は備考へ流さない。テンプレートは「特約事項」と「備考」を別の枠で
    // 出しているので、SPECIAL_TERMS を REMARKS 系のフォールバックに混ぜると
    // 特約だけ入力したときに同じ文が両方の枠に出る（＝特約欄が二重表示になる）。
    // REMARKS は「備考枠を出すか」の判定にも使われるため、備考系の値だけで決める。
    REMARKS: pick(source, "REMARKS", "REMARKS_FIXED", "REMARKS_FREE"),
    REMARKS_FIXED: pick(source, "REMARKS_FIXED", "REMARKS"),
    REMARKS_FREE: pick(source, "REMARKS_FREE"),
    SPECIAL_TERMS: pick(source, "SPECIAL_TERMS"),
    CALC_METHOD: pick(source, "CALC_METHOD", "calc_method") || calcMethods[0] || "",
    PAYMENT_TERMS: pick(source, "PAYMENT_TERMS", "summaryPaymentTerms", "payment_terms"),
    has_license_conditions: financialConditions.length > 0 || royaltyItems.length > 0,
    has_performance_incentive: calcMethods.includes("ROYALTY") || royaltyItems.length > 0,
    has_seller_owned_license:
      toBoolean(source.has_seller_owned_license) ||
      financialConditions.some((row) =>
        ["受注者", "seller", "vendor"].includes(String(pick(row, "rights_holder", "owner")).toLowerCase())) ||
      royaltyItems.some((item) =>
        String(pick(item, "deliverable_ownership", "rights_holder")) === "受注者")
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

// 構造化入力（フォーム再設計の rs* フィールド）が入っているときは、共有エンジンで
// テンプレート変数（grossRoyaltyStr / mg・ag* / lineGroups 等）を組み立てる。
// 旧下書き（手入力の *Str フィールド）は構造化入力が無いのでそのまま通る。
function structuredStatementPatch(source: Data): Data | null {
  const receipts = records(source.rs_receipts)
    .filter((row) => String(pick(row, "sublicensee", "productName")).trim() !== "" || number(row.amount) > 0);
  if (String(source.statementMode) === "multi" && receipts.length) {
    const ratePct = number(pick(source, "rsInRatePct", "rsRatePct", "royaltyRatePct"));
    return buildMultiStatementPatch({
      receipts: receipts.map((row) => ({
        sublicensee: String(pick(row, "sublicensee", "productName")),
        receivedOn: String(row.receivedOn ?? ""),
        currency: String(row.currency ?? "JPY"),
        amount: number(row.amount),
        fxMode: String(row.fxMode) === "post" ? "post" : "pre",
        fxRate: number(row.fxRate) || undefined,
        productName: row.productName == null ? undefined : String(row.productName)
      })),
      ratePct,
      taxRatePct: number(pick(source, "taxRate", "tax_rate"), 10),
      contractTitle: String(pick(source, "contractTitle", "CONTRACT_TITLE", "originalWork")),
      contractNumber: String(pick(source, "linked_contract_number", "CONTRACT_NO")),
      methodLabel: String(pick(source, "methodLabel", "royaltyCategory")) || "サブライセンス受領ベース"
    }).patch;
  }
  const calcBasis = String(source.rsCalcType ?? "");
  const msrp = number(source.rsMsrp);
  if (String(source.statementMode) !== "multi" && calcBasis && msrp > 0) {
    const calcType = calcBasis === "event"
      ? "manufacturing"
      : String(source.rsBasisKind) === "sublicense" ? "sublicense" : "sales";
    const patch = buildSingleStatementPatch({
      calcType,
      msrp,
      quantity: number(source.rsQuantity),
      sampleQuantity: number(source.rsSampleQuantity),
      ratePct: number(pick(source, "rsRatePct", "royaltyRatePct")),
      mgAmount: number(source.rsMgAmount),
      agAmount: number(source.rsAgAmount),
      agConsumedBefore: number(source.rsAgConsumedBefore),
      taxRatePct: number(pick(source, "taxRate", "tax_rate"), 10)
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

function buildRoyaltyStatementContext(rawSource: Data) {
  const structured = structuredStatementPatch(rawSource);
  const source: Data = structured ? { ...rawSource, ...structured } : rawSource;
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

// 明細ごとの発注額との差分（金額変更）。理由付きで PDF に注記する。
function inspectionLineChange(line: Data): { hasChange: boolean; changeLabel: string; changeNote: string } {
  const ordered = number(line.ordered_amount_ex_tax, Number.NaN);
  const inspected = number(pick(line, "inspected_amount_ex_tax", "amount_ex_tax", "amount"));
  const reason = String(line.change_reason ?? "").trim();
  const differs = Number.isFinite(ordered) && ordered !== inspected;
  if (!differs && !reason) return { hasChange: false, changeLabel: "", changeNote: "" };
  return {
    hasChange: true,
    changeLabel: differs ? `支払対価 ¥${yen(ordered)} → ¥${yen(inspected)}` : "",
    changeNote: reason
  };
}

function buildInspectionContext(source: Data) {
  const allLines = records(pick(source, "delivery_line_items", "items", "line_items"));
  // 明細ごとの検収状態: skip（未検収）は PDF に載せない。paid（検収済み・過去分）が
  // あるときは「支払日ごとのグループ表示」（配信中テンプレの useGroupedInspection）へ。
  const visibleLines = allLines.filter((line) => inspectionLineStatus(line) !== "skip");
  const nowLines = visibleLines.filter((line) => inspectionLineStatus(line) === "now");
  const paidLines = visibleLines.filter((line) => inspectionLineStatus(line) === "paid");
  const deliveryLines = nowLines;
  const expenses = records(source.expenses);
  const otherFees = records(source.other_fees);
  const manualChangeLogs = records(source.changeLogs).length
    ? records(source.changeLogs)
    : parseChangeLogs(source.CHANGE_RECORDS);
  // 金額変更（発注額との差）を明細から自動で変更履歴へ起こす（詳細表モードの注記）。
  // グループ表示モードでは各行の直下に hasChange 注記として出るので二重にはしない。
  const autoChangeLogs = paidLines.length ? [] : nowLines.flatMap((line) => {
    const change = inspectionLineChange(line);
    if (!change.hasChange) return [];
    return [{
      changedAt: String(pick(source, "inspectionCompletedAt", "documentDate")),
      fieldLabel: `${String(pick(line, "item_name", "description")) || "明細"} 支払対価`,
      beforeValue: `¥${yen(number(line.ordered_amount_ex_tax))}`,
      afterValue: `¥${yen(number(pick(line, "inspected_amount_ex_tax", "amount_ex_tax", "amount")))}`,
      reason: change.changeNote || "（理由未記入）"
    }];
  });
  const changeLogs = [...manualChangeLogs, ...autoChangeLogs];
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
  // 納品額・消費税額・合計額は、明細があれば明細から計算して**手入力より優先**する
  // （発注書と同じ規則：行があるのに手入力が勝つと画面と PDF がずれる）。
  // 式はフォームの合計パネルと同じ共有関数＝画面と PDF は必ず一致する。
  // 明細0件は従来どおり単票フォールバック＝手入力値をそのまま使う。
  const shared = computeInspectionTotals(source as Record<string, unknown>);
  const lineTotals = deliveryLines.length ? {
    deliveredAmountStr: yen(shared.deliveredExTax),
    taxAmountStr: yen(shared.tax),
    totalAmountStr: yen(shared.totalIncTax)
  } : {};
  // 検収済み（過去分）が混ざるときは支払日ごとのグループ表示（配信中テンプレの
  // useGroupedInspection）。グループ別に消費税を端数処理（課税仕入れの時期ごと）。
  const groupTaxRate = shared.taxRate;
  const buildPaymentGroup = (date: string, isPaid: boolean, lines: Data[]) => {
    const subtotal = lines.reduce((sum, line) =>
      sum + number(pick(line, "inspected_amount_ex_tax", "amount_ex_tax", "amount")), 0);
    const taxAmount = Math.ceil(subtotal * groupTaxRate / 100);
    return {
      date, isPaid, taxRate: groupTaxRate,
      lines: lines.map((line) => ({
        item_name: pick(line, "item_name", "description"),
        spec: line.spec ?? "",
        delivery_date: pick(line, "delivery_date", "deliveredAt") || pick(source, "deliveredAt"),
        amount_ex_tax: number(pick(line, "inspected_amount_ex_tax", "amount_ex_tax", "amount")),
        ...inspectionLineChange(line)
      })),
      subtotalStr: yen(subtotal),
      taxAmountStr: yen(taxAmount),
      totalIncTaxStr: yen(subtotal + taxAmount)
    };
  };
  // 進捗（検収率・検収済額・発注総額・未検収額）は明細の状態から自動計算する。
  // 手入力欄は旧フォームの名残＝明細があるときは計算値が手入力より優先（合計と同じ規則）。
  const lineAmount = (line: Data) =>
    number(pick(line, "inspected_amount_ex_tax", "amount_ex_tax", "amount"));
  const orderedTotal = allLines.reduce((sum, line) => {
    const ordered = number(line.ordered_amount_ex_tax, Number.NaN);
    return sum + (Number.isFinite(ordered) ? ordered : lineAmount(line));
  }, 0);
  const inspectedSoFar = [...paidLines, ...nowLines].reduce((sum, line) => sum + lineAmount(line), 0);
  const progress = allLines.length && orderedTotal > 0 ? {
    totalOrderAmountStr: yen(orderedTotal),
    inspectedAmountStr: yen(inspectedSoFar),
    pendingAmountStr: yen(Math.max(0, orderedTotal - inspectedSoFar)),
    inspectedPct: Math.min(100, Math.round((inspectedSoFar / orderedTotal) * 100))
  } : {};
  const paidByDate = new Map<string, Data[]>();
  for (const line of paidLines) {
    const date = String(line.paid_date ?? "").trim() || "（支払日未入力）";
    paidByDate.set(date, [...(paidByDate.get(date) ?? []), line]);
  }
  const paymentGroups = paidLines.length ? [
    ...[...paidByDate.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([date, lines]) => buildPaymentGroup(date, true, lines)),
    ...(nowLines.length
      ? [buildPaymentGroup(String(pick(source, "paymentDueDate", "PAYMENT_DATE")), false, nowLines)]
      : [])
  ] : [];
  return {
    ...source,
    ...lineTotals,
    ...progress,
    useGroupedInspection: paidLines.length > 0,
    paymentGroups,
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
