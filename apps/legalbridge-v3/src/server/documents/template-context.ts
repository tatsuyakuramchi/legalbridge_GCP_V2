/**
 * ひな形ごとの計算ブロック。
 *
 * 移行したひな形の本文は V1 のものそのままで、合計を自分では計算しない。
 * 「消費税」「税込合計」「明細表」はサーバが組んだ値を差すだけなので、
 * それを作る側が無いと消費税が空欄のまま書類が出る（実際に出た）。
 *
 * V1 は form_data の配列から組んでいた（template-context-adapters.ts）。
 * V3 は同じ形を **条件・予定・実績から** 組む。人が明細を打ち直さずに済む、
 * というのが V3 の建て付けなので、供給元はドメインでなければならない。
 *
 * 出す名前は V1 と同じにしてある。名前を変えると本文が差せなくなる。
 */

import {
  aggregateItemDates, computeInspectionTotals, inspectionTaxBreakdown,
  num, purchaseOrderTotals, rows, taxRatePercentFor, yen, type Row
} from "./legacy-totals.js";
import { royaltyStatementPatch } from "./royalty-patch.js";

type Ctx = Record<string, any>;

const INSPECTION_KEYS = new Set(["inspection_certificate", "delivery_note", "acceptance_certificate"]);
const PURCHASE_ORDER_KEYS = new Set(["purchase_order", "intl_purchase_order"]);

/** 相手先が「1件の条件」に決まるときだけ、条件から明細を組める。 */
const singleCondition = (c: Ctx) => (c.conditions?.length === 1 ? c.conditions[0] : null);

/**
 * 検収・納品の明細を実績から組む。
 *
 * 実績（condition_events）1件が明細1行。検収書は「どの回の分か」を書く
 * 書類なので、行の出どころは実績以外にありえない。実績を選ばずに作った
 * ときだけ、条件そのものを1行として置く（単発の業務委託）。
 */
export function deliveryLinesFrom(context: Ctx): Row[] {
  const events = (context.events ?? []) as Ctx[];
  if (events.length) {
    return events.map((event) => {
      const condition = (context.conditions ?? []).find((c: Ctx) => c.id === event.conditionId)
        ?? context.condition ?? {};
      return {
        item_name: condition.name ?? condition.work?.title ?? "",
        // 業務内容の本文。条件の備考は「何をしてもらったか」が書いてある欄。
        spec: condition.notes ?? event.note ?? "",
        description: condition.notes ?? event.note ?? "",
        quantity: event.quantity ?? null,
        delivery_date: event.occurredOn ?? null,
        payment_date: event.schedule?.payOn ?? event.schedule?.dueOn ?? null,
        amount_ex_tax: event.amount ?? 0,
        inspected_amount_ex_tax: event.amount ?? 0,
        // 予定額。ここと違えば「金額変更」として本文の変更履歴に出る。
        ordered_amount_ex_tax: event.plannedAmount ?? null,
        tax_category: condition.taxCategory ?? "taxable",
        inspection_status: "now",
        calc_method: String(condition.pricingModel ?? "").toUpperCase()
      };
    });
  }
  const condition = singleCondition(context);
  if (!condition || !condition.flatAmount) return [];
  return [{
    item_name: condition.name ?? "",
    spec: condition.notes ?? "",
    description: condition.notes ?? "",
    quantity: null,
    delivery_date: condition.termEnd ?? null,
    payment_date: null,
    amount_ex_tax: condition.flatAmount,
    inspected_amount_ex_tax: condition.flatAmount,
    ordered_amount_ex_tax: condition.flatAmount,
    tax_category: condition.taxCategory ?? "taxable",
    inspection_status: "now",
    calc_method: String(condition.pricingModel ?? "").toUpperCase()
  }];
}

/**
 * 発注の明細を予定から組む。
 *
 * 発注書は「これから何回いくら払うか」を書く書類なので、行は予定明細
 * （condition_schedules）。予定を持たない条件は総額を1行にする。
 */
export function orderLinesFrom(context: Ctx): Row[] {
  const schedules = (context.schedules ?? []) as Ctx[];
  if (schedules.length) {
    return schedules.map((s) => {
      const condition = (context.conditions ?? []).find((c: Ctx) => c.id === s.conditionId)
        ?? context.condition ?? {};
      return {
        item_name: s.label ?? condition.name ?? "",
        spec: condition.notes ?? "",
        quantity: null,
        delivery_date: s.dueOn ?? null,
        payment_date: s.payOn ?? null,
        amount_ex_tax: s.plannedAmount ?? 0,
        tax_category: condition.taxCategory ?? "taxable",
        calc_method: String(condition.pricingModel ?? "").toUpperCase()
      };
    });
  }
  return (context.conditions ?? [])
    .filter((c: Ctx) => c.flatAmount)
    .map((c: Ctx) => ({
      item_name: c.name ?? "",
      spec: c.notes ?? "",
      quantity: null,
      delivery_date: c.termEnd ?? null,
      payment_date: null,
      amount_ex_tax: c.flatAmount,
      tax_category: c.taxCategory ?? "taxable",
      calc_method: String(c.pricingModel ?? "").toUpperCase()
    }));
}

/**
 * 税率（%）。条件の税区分から引く。
 * 手入力があればそれを優先する（軽減税率の例外を人が指定する場合）。
 */
export function taxRateFor(context: Ctx, manual: Record<string, unknown>): number {
  const typed = manual.taxRate ?? manual.tax_rate;
  if (typed !== undefined && typed !== null && String(typed).trim() !== "") {
    return Math.max(0, num(typed, 10));
  }
  const conditions = (context.conditions ?? []) as Ctx[];
  if (!conditions.length) return taxRatePercentFor(context.condition?.taxCategory);
  // 区分が混在するときは、いちばん高い率を全体の表示率にする。内訳は
  // taxBreakdown 側に区分ごとで出る（本文の「消費税(x%)」は1つしか出せない）。
  return Math.max(...conditions.map((c) => taxRatePercentFor(c.taxCategory)));
}

/** 振込先の1行表記。V1 の buildPurchaseOrderContext と同じ並び。 */
export function bankInfoLine(bank: Ctx | null | undefined): string {
  if (!bank) return "";
  const type = accountTypeLabel(bank.accountType);
  return [
    bank.bankName,
    bank.branchName,
    [type, bank.accountNumber].filter(Boolean).join(" "),
    bank.holderKana
  ].filter((v) => v !== null && v !== undefined && String(v).trim() !== "").join(" / ");
}

/** 口座種別。DB は英字で持つが、書類に出すのは日本語。 */
export function accountTypeLabel(value: unknown): string {
  const key = String(value ?? "").trim().toLowerCase();
  if (!key) return "";
  return ({
    ordinary: "普通", futsu: "普通", "普通": "普通", "普通預金": "普通",
    checking: "当座", touza: "当座", "当座": "当座", "当座預金": "当座",
    savings: "貯蓄", "貯蓄": "貯蓄", "貯蓄預金": "貯蓄"
  } as Record<string, string>)[key] ?? String(value);
}

/**
 * ひな形ごとの計算ブロックを組む。
 *
 * 手入力が明細を持っているならそちらが正（人が直した明細を計算で消さない）。
 * 明細が1行でもあれば、金額は明細から計算して手入力より優先する。V1 と同じ
 * 規則：行があるのに手入力が勝つと、本文の表と合計がずれる。
 */
export function buildTemplateContext(
  templateKey: string, context: Ctx, manual: Record<string, unknown> = {}
): Record<string, unknown> {
  const bank = context.bank ?? null;
  const common: Record<string, unknown> = {
    taxRate: taxRateFor(context, manual),
    BANK_INFO: bankInfoLine(bank),
    BANK_NAME: bank?.bankName ?? "",
    BRANCH_NAME: bank?.branchName ?? "",
    ACCOUNT_TYPE: accountTypeLabel(bank?.accountType),
    ACCOUNT_NUMBER: bank?.accountNumber ?? "",
    ACCOUNT_HOLDER_KANA: bank?.holderKana ?? ""
  };

  if (INSPECTION_KEYS.has(templateKey)) {
    return { ...common, ...inspectionBlock(context, manual, Number(common.taxRate)) };
  }
  if (PURCHASE_ORDER_KEYS.has(templateKey)) {
    return { ...common, ...orderBlock(templateKey, context, manual) };
  }
  if (templateKey === "royalty_statement") {
    const patch = royaltyStatementPatch(context, manual, Number(common.taxRate));
    return patch ? { ...common, ...patch } : common;
  }
  return common;
}

function inspectionBlock(context: Ctx, manual: Record<string, unknown>, taxRate: number) {
  const lines = rows(manual.delivery_line_items).length
    ? rows(manual.delivery_line_items)
    : deliveryLinesFrom(context);
  const otherFees = rows(manual.other_fees);
  const expenses = rows(manual.expenses);
  const source: Row = { delivery_line_items: lines, other_fees: otherFees, expenses, taxRate };
  const totals = computeInspectionTotals(source);
  const breakdown = inspectionTaxBreakdown(source);

  const visible = lines.filter((l) => String(l.inspection_status ?? "now") !== "skip");
  const paid = visible.filter((l) => String(l.inspection_status ?? "") === "paid");
  const now = visible.filter((l) => String(l.inspection_status ?? "now") === "now");

  // 進捗（検収率・検収済額・発注総額・未検収額）。予定額を持つ行から出す。
  const lineAmount = (l: Row) => num(l.inspected_amount_ex_tax ?? l.amount_ex_tax ?? l.amount);
  const orderedTotal = visible.reduce((sum, l) => {
    const ordered = num(l.ordered_amount_ex_tax, Number.NaN);
    return sum + (Number.isFinite(ordered) ? ordered : lineAmount(l));
  }, 0);
  const inspectedSoFar = [...paid, ...now].reduce((sum, l) => sum + lineAmount(l), 0);
  const progress = visible.length && orderedTotal > 0 ? {
    totalOrderAmountStr: yen(orderedTotal),
    inspectedAmountStr: yen(inspectedSoFar),
    pendingAmountStr: yen(Math.max(0, orderedTotal - inspectedSoFar)),
    inspectedPct: Math.min(100, Math.round((inspectedSoFar / orderedTotal) * 100))
  } : {};

  // 金額変更（予定との差）は本文の変更履歴に出す。理由は書けないので
  // 「（理由未記入）」のまま出す。黙って消すより残すほうがよい。
  const changeLogs = now.flatMap((l) => {
    const ordered = num(l.ordered_amount_ex_tax, Number.NaN);
    const actual = lineAmount(l);
    if (!Number.isFinite(ordered) || ordered === actual) return [];
    return [{
      changedAt: String(context.document?.issuedOn ?? ""),
      fieldLabel: `${String(l.item_name ?? "明細")} 支払対価`,
      beforeValue: `¥${yen(ordered)}`,
      afterValue: `¥${yen(actual)}`,
      reason: "（理由未記入）"
    }];
  });

  const taxableSubtotal = totals.deliveredExTax + totals.otherFeesExTax;
  const combinedTax = Math.ceil((taxableSubtotal * taxRate) / 100);
  const taxableTotal = taxableSubtotal + combinedTax;

  // 明細が1行も無いときは、金額は手入力に任せる（単票フォールバック）。
  const lineTotals = lines.length ? {
    deliveredAmountStr: yen(totals.deliveredExTax),
    taxAmountStr: yen(totals.tax),
    totalAmountStr: yen(totals.totalIncTax),
    // 数値で欲しい本文もあるので両方出す。
    deliveredAmountExTax: totals.deliveredExTax,
    taxAmount: totals.tax,
    totalAmountIncTax: totals.totalIncTax
  } : {};

  return {
    ...lineTotals,
    ...progress,
    delivery_line_items: now,
    items: now,
    expenses,
    other_fees: otherFees,
    changeLogs,
    hasChangeLogs: changeLogs.length > 0,
    useGroupedInspection: paid.length > 0,
    paymentGroups: paid.length ? paymentGroups(paid, now, taxRate, context) : [],
    otherFeesTaxable: totals.otherFeesExTax > 0,
    hasSettlement: totals.hasSettlement,
    otherFeesTotalStr: yen(totals.otherFeesExTax),
    expensesTotalIncTaxStr: yen(totals.expensesIncTax),
    taxableSubtotalExTaxStr: yen(taxableSubtotal),
    combinedTaxStr: yen(combinedTax),
    taxableTotalIncTaxStr: yen(taxableTotal),
    grandTotalPayableStr: yen(taxableTotal + totals.expensesIncTax),
    // 経理提出用の税区分内訳。列がある本文だけが使う。
    taxBreakdown: breakdown
  };
}

/** 支払日ごとのまとまり。区切りごとに端数処理する（課税仕入れの時期が違う）。 */
function paymentGroups(paid: Row[], now: Row[], taxRate: number, context: Ctx) {
  const build = (date: string, isPaid: boolean, lines: Row[]) => {
    const subtotal = lines.reduce((sum, l) =>
      sum + num(l.inspected_amount_ex_tax ?? l.amount_ex_tax ?? l.amount), 0);
    const tax = Math.ceil((subtotal * taxRate) / 100);
    return {
      date, isPaid, taxRate,
      lines: lines.map((l) => ({
        item_name: l.item_name ?? "",
        spec: l.spec ?? "",
        delivery_date: l.delivery_date ?? "",
        amount_ex_tax: num(l.inspected_amount_ex_tax ?? l.amount_ex_tax ?? l.amount)
      })),
      subtotalStr: yen(subtotal),
      taxAmountStr: yen(tax),
      totalIncTaxStr: yen(subtotal + tax)
    };
  };
  const byDate = new Map<string, Row[]>();
  for (const line of paid) {
    const date = String(line.payment_date ?? line.paid_date ?? "").trim() || "（支払日未入力）";
    byDate.set(date, [...(byDate.get(date) ?? []), line]);
  }
  return [
    ...[...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([date, lines]) => build(date, true, lines)),
    ...(now.length
      ? [build(String(now[0]?.payment_date ?? context.schedule?.payOn ?? ""), false, now)]
      : [])
  ];
}

function orderBlock(templateKey: string, context: Ctx, manual: Record<string, unknown>) {
  const items = rows(manual.items).length ? rows(manual.items) : orderLinesFrom(context);
  const otherFees = rows(manual.other_fees);
  const expenses = rows(manual.expenses);
  const totals = purchaseOrderTotals({ items, other_fees: otherFees });
  const intl = templateKey === "intl_purchase_order";
  const deliveryDate = aggregateItemDates(items, "delivery_date", intl);
  const paymentDate = aggregateItemDates(items, "payment_date", intl);
  const expensesTotalIncTax = expenses.reduce((sum, e) =>
    sum + num(e.amount_inc_tax ?? e.amount), 0);
  return {
    items,
    other_fees: otherFees,
    expenses,
    itemsSubtotalExTax: totals.itemsSubtotalExTax,
    otherFeesTotal: totals.otherFeesTotal,
    // 明細も手数料も無い発注書は総額を手入力する運用が残っている。
    // 行があるときだけ計算値で上書きする。
    ...(items.length || otherFees.length ? { grandTotalExTax: totals.grandTotalExTax } : {}),
    expensesTotalIncTax,
    expensesTotalIncTaxStr: yen(expensesTotalIncTax),
    itemsSubtotalExTaxStr: yen(totals.itemsSubtotalExTax),
    otherFeesTotalStr: yen(totals.otherFeesTotal),
    grandTotalExTaxStr: yen(totals.grandTotalExTax),
    summaryDeliveryDate: deliveryDate,
    summaryPaymentDate: paymentDate,
    ...(intl ? { summaryCompletionDate: deliveryDate } : {}),
    DELIVERY_DATE: deliveryDate,
    PAYMENT_DATE: paymentDate
  };
}
