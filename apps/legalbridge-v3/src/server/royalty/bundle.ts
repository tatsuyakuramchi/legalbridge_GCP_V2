import { DomainError } from "../core/errors.js";
import { usageBundleLines, type BundleLine } from "../documents/royalty-patch.js";
import { toMajor } from "./economics.js";
import type { CalculationPreview } from "./statement-service.js";

/**
 * 束ねた計算書の1枚ぶん。
 *
 * 作品ひとつに取引モデルが何本もある（自社製造・自社販売、再許諾…）とき、
 * 相手先に出す計算書は1枚で、中は条件ごとの内訳になる。V1・V2 は
 * rs_bundle という手入力の表でこれをやっていて、印字のたびに計算し直して
 * いた。V3 は条件ごとの試算（＝データベースに入る金額）をそのまま印字する。
 *
 * ここは印字用の行に直すだけ。計算は statement-service が持つ。
 */

const fmtYen = (value: number) => new Intl.NumberFormat("ja-JP").format(Math.round(value));

/** 何を根拠に計算したかの見出し。V1 の methodLabel と同じ言い回し。 */
export function methodLabelOf(preview: CalculationPreview): string {
  const model = preview.condition.pricingModel;
  if (model === "unit_rate") return "製造数量ベース";
  if (model === "fixed") return "定額";
  if (model === "subscription") return "定期課金";
  return preview.events.some((e) => e.eventType === "sublicense_receipt")
    ? "サブライセンス受領ベース" : "売上報告ベース";
}

/**
 * 根拠額（税抜・主単位）。料率なら報告売上、数量ベースなら 有償数量×基準価格。
 * どちらでもない条件は、根拠と実額が同じものとして総額を置く。
 */
export function basisAmountOf(preview: CalculationPreview): number {
  const { currency, pricingModel, unitAmount } = preview.condition;
  if (pricingModel === "revenue_rate") {
    return toMajor(preview.reported.salesInput ?? 0,
                   preview.reported.intakeCurrency ?? currency);
  }
  if (pricingModel === "unit_rate") {
    const quantity = Number(preview.reported.quantity ?? 0);
    const sample = Number(preview.reported.sampleQuantity ?? 0);
    return Math.max(0, quantity - sample) * unitAmount;
  }
  return preview.fee.gross_ex_tax;
}

/** その行がどう出たのかの但し書き。金額だけ並んでいても検算できない。 */
export function basisNoteOf(preview: CalculationPreview): string {
  const notes: string[] = [];
  if (preview.period) notes.push(`算定期間 ${preview.period}`);
  if (preview.condition.pricingModel === "unit_rate") {
    const quantity = Number(preview.reported.quantity ?? 0);
    const sample = Number(preview.reported.sampleQuantity ?? 0);
    notes.push(`${Math.max(0, quantity - sample)}個 × 基準価格`);
  }
  if (preview.fee.mg_floor_applied) notes.push(`MG適用 +${fmtYen(preview.fee.mg_topup_this_time)}`);
  if (preview.fee.ag_offset_this_time > 0) {
    notes.push(`AG充当 −${fmtYen(preview.fee.ag_offset_this_time)}`);
  }
  if (preview.events.length) notes.push(`実績 ${preview.events.length} 件`);
  return notes.join("・");
}

/**
 * 1枚の計算書に載せる行。
 *
 * 利用形態の付いた実績は、実績1件が1行になる（前金と後金、再許諾と自社販売で
 * 料率も相手も違うので、条件で1行にまとめると内訳が消える）。
 * 利用形態の無い実績は、これまでどおり条件1本で1行。
 *
 * 入口が2つある（条件の画面から直接／文書作成フォームから）。ここを通さないと
 * 片方の入口だけ明細の作りが変わり、同じ実績から違う紙が出る。
 */
export function bundleLinesFor(preview: CalculationPreview): BundleLine[] {
  const usage = preview.events.filter((e) => e.usageType);
  if (usage.length) return usageBundleLines(usage);
  // 出版の実績（行ごとに切り捨て）は、実績 1 件が 1 行（報告月 × 書店 × 作品）。
  if (preview.events.length && preview.events.every((e) => e.amount !== null && e.amount !== undefined)) {
    return eventBundleLines(preview);
  }
  return [bundleLineFrom(preview)];
}

/** 実績ごとに額の出ている計算（出版の印税）を、実績 1 件 1 行にする。 */
export function eventBundleLines(preview: CalculationPreview): BundleLine[] {
  const c = preview.condition;
  const currency = c.currency;
  return preview.events.map((e) => ({
    conditionId: c.id,
    eventId: e.eventId,
    contractTitle: c.agreementTitle ?? "",
    contractNumber: c.agreementNo ?? c.conditionNo ?? "",
    conditionName: e.productName ?? c.name,
    methodLabel: methodLabelOf(preview),
    salesJpy: toMajor(e.basis, currency),
    ratePct: e.ratePct ?? c.ratePct,
    paymentJpy: toMajor(e.amount ?? 0, currency),
    basisNote: [e.period ? `対象期間 ${e.period}` : "", storeOfNote(e.note)].filter(Boolean).join("・"),
    occurredOn: e.occurredOn ?? null,
    quantity: Number(e.quantity ?? 0) > 0
      ? Math.max(0, Number(e.quantity ?? 0) - Number(e.sampleQuantity ?? 0)) : null,
    // 出版の計算書（royalty_statement_pub）の要約・別紙に使う。
    workTitle: e.workTitle ?? null,
    media: mediaLabel(e.conditionUsageType),
    unitPrice: e.unitAmount === null || e.unitAmount === undefined ? null : toMajor(e.unitAmount, currency),
    store: storeOfNote(e.note) || null,
    period: e.period ?? null
  }));
}

/** 出版の利用形態 → 紙に出す媒体名。出版でなければ空。 */
export function mediaLabel(usageType: string | null | undefined): string | null {
  if (usageType === "pub_digital") return "電子";
  if (usageType === "pub_print") return "紙";
  return null;
}

/** 取込の備考「電子書籍売上取込 2026-03｜BOOKWALKER（PC）｜…」から書店名。 */
function storeOfNote(note: string | null | undefined): string {
  const m = String(note ?? "").match(/^電子書籍売上取込 [^｜\s]+｜([^｜]*)/);
  return m ? m[1].trim() : "";
}

export function bundleLineFrom(preview: CalculationPreview): BundleLine {
  const c = preview.condition;
  return {
    conditionId: c.id,
    contractTitle: c.agreementTitle ?? "",
    contractNumber: c.agreementNo ?? c.conditionNo ?? "",
    conditionName: c.name,
    methodLabel: methodLabelOf(preview),
    salesJpy: basisAmountOf(preview),
    ratePct: c.ratePct,
    paymentJpy: preview.fee.actual_ex_tax,
    basisNote: basisNoteOf(preview),
    occurredOn: preview.occurredOn ?? null,
    quantity: Number(preview.reported.quantity ?? 0) > 0
      ? Math.max(0, Number(preview.reported.quantity ?? 0)
                  - Number(preview.reported.sampleQuantity ?? 0)) : null
  };
}

export interface BundleTotals {
  currency: string;
  /** 主単位。印字用。 */
  basis: number;
  netExTax: number;
  tax: number;
  totalIncTax: number;
  withholdingTax: number;
  netTransfer: number;
  /** 最小通貨単位。支払を立てるときはこちら。 */
  netMinor: number;
}

/**
 * 束ねの合計。
 *
 * 通貨と相手先が混ざったものは束ねない。1枚の計算書は1社に出す1通貨の紙で、
 * 混ぜると合計が意味を持たなくなる。消費税は条件ごとの税区分が違いうるので、
 * 総額に税率を掛けず、条件ごとの税額を足す。
 */
export function bundleTotals(previews: CalculationPreview[]): BundleTotals {
  if (!previews.length) throw new DomainError("VALIDATION", "条件を1件以上選んでください");
  const currencies = [...new Set(previews.map((p) => p.condition.currency))];
  if (currencies.length > 1) {
    throw new DomainError("VALIDATION",
      `通貨の違う条件は1枚にまとめられません（${currencies.join("・")}）`);
  }
  const parties = [...new Set(previews.map((p) => p.condition.counterpartyId).filter((x) => x !== null))];
  if (parties.length > 1) {
    throw new DomainError("VALIDATION", "相手先の違う条件は1枚にまとめられません");
  }
  const sum = (pick: (p: CalculationPreview) => number) =>
    previews.reduce((total, p) => total + pick(p), 0);
  return {
    currency: currencies[0],
    basis: sum(basisAmountOf),
    netExTax: sum((p) => p.fee.actual_ex_tax),
    tax: sum((p) => p.fee.tax_amount),
    totalIncTax: sum((p) => p.fee.total_inc_tax),
    withholdingTax: sum((p) => p.payment.withholdingTax),
    netTransfer: sum((p) => p.payment.netTransfer),
    netMinor: sum((p) => p.amounts.netMinor)
  };
}
