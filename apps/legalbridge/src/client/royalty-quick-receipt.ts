// 利用許諾料計算書「かんたん受領入力」（ライセンスアウト入金 → 許諾者への支払）の純関数（2026-09-04）。
//
// 入力は 3 つだけ: ①支払先＝利用許諾イン条件明細（料率・MG/AG・AG消化累計は台帳から）
// ②入金元＝利用許諾アウト条件明細（サブライセンシー）または名称 ③入金額（受領日・通貨）。
// それ以外の計算書の欄（ライセンサー・ライセンシー・原著作物・製品名・契約番号・入金企業・
// デザイナー／権利者・カテゴリー・通貨）はここから埋める。計算は多明細（受領→支払）モード
// （statementMode: multi）で共有エンジンが行う。

import type { DocumentFormData } from "../types";

export interface QuickLine {
  id: number;
  documentNumber: string | null;
  conditionName: string;
  vendorName: string;
  workTitle: string;
  currency: string | null;
}
export interface QuickEconomics {
  representativeLineId: number;
  conditionName: string | null;
  ratePct: number;
  mgAmount: number;
  agAmount: number;
  agConsumed: number;
}
export interface QuickReceipt {
  sublicensee: string;
  receivedOn: string;
  currency: string;
  amount: number | "";
  fxMode: "pre" | "post";
  fxRate: number | "";
}

export function emptyQuickReceipt(): QuickReceipt {
  return { sublicensee: "", receivedOn: "", currency: "JPY", amount: "", fxMode: "pre", fxRate: "" };
}

export function buildQuickReceiptPatch(input: {
  inLine: QuickLine;
  economics: QuickEconomics;
  outLine: QuickLine | null;
  receipt: QuickReceipt;
  companyName: string;
  existing?: DocumentFormData;
}): DocumentFormData {
  const { inLine, economics, outLine, receipt, companyName } = input;
  const sublicensee = receipt.sublicensee.trim() || outLine?.vendorName || "";
  const currency = (receipt.currency || "JPY").toUpperCase();
  const foreign = currency !== "JPY";
  const work = inLine.workTitle || outLine?.workTitle || "";
  const existingReceipts = Array.isArray(input.existing?.rs_receipts)
    ? (input.existing!.rs_receipts as Array<Record<string, unknown>>).filter((r) => String(r.sublicensee ?? "").trim() || Number(r.amount) > 0)
    : [];
  const row = {
    sublicensee, receivedOn: receipt.receivedOn, currency, amount: receipt.amount,
    fxMode: foreign ? receipt.fxMode : "post", fxRate: foreign ? receipt.fxRate : ""
  };
  return {
    statementMode: "multi",
    // 支払先（イン条件）: 記帳先・料率・MG/AG
    rsConditionLineId: economics.representativeLineId,
    rsInRatePct: economics.ratePct,
    rsRatePct: economics.ratePct,
    rsMgAmount: economics.mgAmount,
    rsAgAmount: economics.agAmount,
    rsAgConsumedBefore: economics.agConsumed,
    licensor: inLine.vendorName,
    designerName: inLine.vendorName,
    linked_contract_number: inLine.documentNumber ?? "",
    contractTitle: inLine.conditionName || economics.conditionName || "",
    originalWork: work,
    productName: outLine?.conditionName || (work ? `${work}（サブライセンス受領分）` : "サブライセンス受領分"),
    // 入金元（アウト条件・サブライセンシー）
    payerCompany: sublicensee,
    royaltyCategory: "サブライセンス受領ベース",
    intakeCurrency: currency,
    ...(foreign && receipt.fxRate !== "" ? { fxRate: receipt.fxRate } : {}),
    // 自社・通貨
    ...(companyName ? { licensee: companyName } : {}),
    currency: "JPY",
    // 受領行（既存の行があれば末尾に足す）
    rs_receipts: [...existingReceipts, row]
  };
}

/** 円換算 base（右レール・PDF と同じ丸め）。 */
export function quickReceiptJpy(receipt: QuickReceipt): number {
  const amount = Number(receipt.amount) || 0;
  const foreign = (receipt.currency || "JPY").toUpperCase() !== "JPY";
  if (foreign && receipt.fxMode === "pre") return Math.round(amount * (Number(receipt.fxRate) || 0));
  return Math.round(amount);
}
