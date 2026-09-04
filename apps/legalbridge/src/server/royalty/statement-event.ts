// 利用許諾料計算書の確定 → 消化イベント（royalty_calc）自動記帳の入力組み立て（純関数）。
// V1 は保存時に syncRoyaltyCalcEvent を自動実行していた（worker/server.ts:14757）。
// V2 では計算書フォームに rsConditionLineId（条件明細とのひも付け・任意）を追加し、
// 入っている単票計算書の確定時に、サーバ再計算値で condition_events へ記帳する。
// 束ね（statementMode: bundle・2026-09-04）は条件明細ごとに 1 件ずつ記帳する。
// ひも付けが無い・多明細（受領ベース）・実績未入力の計算書は対象外＝従来どおり手動記帳。
// terms/adjustments の組み立ては buildSingleStatementPatch（PDF・プレビュー）と同一。

import type { DocumentFormData } from "../../types.js";
import type { Adjustments, FeeTerms } from "../../royalty/calc.js";
import { bundleEntriesFrom, bundleEntryActive, receiptJpyBase } from "../../royalty-statement.js";

export interface StatementEventInput {
  conditionLineId: number;
  terms: FeeTerms;
  adjustments: Adjustments;
  taxRatePct: number;
  period: string | null;    // YYYY-MM（時限式の算定期間 To から導出・無ければ null）
}

const toNumber = (value: unknown): number => {
  if (value === "" || value == null) return 0;
  const parsed = Number(String(value).replace(/[,¥\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
};

function periodOf(...values: unknown[]): string | null {
  for (const value of values) {
    const match = String(value ?? "").match(/^(\d{4}-\d{2})/);
    if (match) return match[1];
  }
  return null;
}

/** 単票の記帳入力（従来）。束ね・多明細・ひも付け無し・実績未入力は null。 */
export function royaltyEventInputFromStatement(formData: DocumentFormData): StatementEventInput | null {
  const conditionLineId = Math.trunc(toNumber(formData.rsConditionLineId));
  if (conditionLineId <= 0) return null;
  const mode = String(formData.statementMode ?? "");
  if (mode === "multi" || mode === "bundle") return null;   // 多明細は手動記帳（V1同様に単票のみ）・束ねは別関数
  const calcBasis = String(formData.rsCalcType ?? "");
  const msrp = toNumber(formData.rsMsrp);
  if (!calcBasis || msrp <= 0) return null;

  const ratePct = toNumber(formData.rsRatePct);
  const terms: FeeTerms = calcBasis === "event"
    ? { type: "performance", base_price: msrp, rate_pct: ratePct, quantity: toNumber(formData.rsQuantity) }
    : { type: "revenue", base_amount: msrp, rate_pct: ratePct };
  const adjustments: Adjustments = {
    sample_quantity: calcBasis === "event" ? toNumber(formData.rsSampleQuantity) : 0,
    mg_amount: toNumber(formData.rsMgAmount),
    ag_amount: toNumber(formData.rsAgAmount),
    ag_consumed_before: toNumber(formData.rsAgConsumedBefore)
  };
  const taxRatePct = toNumber(formData.taxRate ?? formData.tax_rate) || 10;
  return { conditionLineId, terms, adjustments, taxRatePct, period: periodOf(formData.rsPeriodTo, formData.rsPeriodFrom) };
}

/** 確定時に記帳する入力の全量。単票は 0〜1 件、多明細（受領→支払）はイン条件へ 0〜1 件、束ねは行ごとに 1 件。 */
export function royaltyEventInputsFromStatement(formData: DocumentFormData): StatementEventInput[] {
  const mode = String(formData.statementMode ?? "");
  const taxRatePct = toNumber(formData.taxRate ?? formData.tax_rate) || 10;
  if (mode === "multi") {
    // かんたん受領入力（ライセンスアウト入金 → 許諾者支払）: 受領行の円換算 base 合計 × イン側料率を
    // イン条件明細へ記帳する。PDF（buildMultiStatementPatch）と同じく MG/AG は掛けない。
    const conditionLineId = Math.trunc(toNumber(formData.rsConditionLineId));
    const receipts = Array.isArray(formData.rs_receipts) ? formData.rs_receipts as Array<Record<string, unknown>> : [];
    const base = receipts.reduce((sum, row) => sum + receiptJpyBase({
      sublicensee: String(row.sublicensee ?? ""), currency: String(row.currency ?? "JPY"), amount: toNumber(row.amount),
      fxMode: String(row.fxMode) === "post" ? "post" : "pre", fxRate: toNumber(row.fxRate) || undefined
    }), 0);
    const ratePct = toNumber(formData.rsInRatePct) || toNumber(formData.rsRatePct);
    if (conditionLineId <= 0 || base <= 0) return [];
    const periods = receipts.map((row) => row.receivedOn).filter(Boolean).sort();
    return [{
      conditionLineId,
      terms: { type: "revenue", base_amount: base, rate_pct: ratePct },
      adjustments: { sample_quantity: 0, mg_amount: 0, ag_amount: 0, ag_consumed_before: 0 },
      taxRatePct,
      period: periodOf(periods.at(-1), formData.rsPeriodTo, formData.paymentDueDate, formData.documentDate)
    }];
  }
  if (mode !== "bundle") {
    const single = royaltyEventInputFromStatement(formData);
    return single ? [single] : [];
  }
  return bundleEntriesFrom(formData)
    .filter((entry) => bundleEntryActive(entry) && entry.conditionLineId != null && entry.conditionLineId > 0)
    .map((entry) => ({
      conditionLineId: entry.conditionLineId as number,
      terms: entry.calcType === "event"
        ? { type: "performance", base_price: entry.msrp, rate_pct: entry.ratePct, quantity: entry.quantity }
        : { type: "revenue", base_amount: entry.msrp, rate_pct: entry.ratePct },
      adjustments: {
        sample_quantity: entry.calcType === "event" ? entry.sampleQuantity : 0,
        mg_amount: entry.mgAmount,
        ag_amount: entry.agAmount,
        ag_consumed_before: entry.agConsumedBefore
      },
      taxRatePct,
      period: periodOf(entry.periodTo, entry.periodFrom)
    }));
}
