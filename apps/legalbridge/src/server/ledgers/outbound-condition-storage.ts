import type { z } from "zod";
import type { outboundConditionSchema } from "./outbound-conditions.js";

type ValidatedOutboundCondition = z.output<typeof outboundConditionSchema>;

export interface OutboundConditionStorageValues {
  workId: number;
  counterpartyVendorId: number;
  transactionKind: "license" | "product";
  direction: "receivable";
  conditionName: string;
  documentNumber: string | null;
  territory: string;
  language: string;
  exclusivity: "exclusive" | "non_exclusive" | "sole";
  sublicenseAllowed: boolean;
  termStart: string | null;
  termEnd: string | null;
  currency: string;
  paymentScheme: "royalty" | "per_unit" | "lump_sum";
  ratePct: number | null;
  amountExTax: number | null;
  mgAmount: number | null;
  agAmount: number | null;
  reportingCycle: string | null;
  paymentTerms: string | null;
  royaltyBase: string | null;
  incoterms: string | null;
  minimumQuantity: number | null;
  sellOffMonths: number | null;
  withholdingTaxTreatment: string | null;
  notes: string | null;
}

export function mapOutboundConditionForStorage(
  condition: ValidatedOutboundCondition
): OutboundConditionStorageValues {
  return {
    workId: numericIdentifier(condition.workId, "work"),
    counterpartyVendorId: numericIdentifier(condition.counterpartyId),
    transactionKind: condition.transactionKind,
    direction: "receivable",
    conditionName: condition.conditionName,
    documentNumber: nullable(condition.documentNumber),
    territory: condition.territory,
    language: condition.languages.join(","),
    exclusivity: condition.exclusivity,
    sublicenseAllowed: condition.sublicenseAllowed,
    termStart: condition.termStart ?? null,
    termEnd: condition.termEnd ?? null,
    currency: condition.currency,
    paymentScheme: condition.paymentScheme,
    ratePct: condition.ratePct ?? null,
    amountExTax: condition.amountExTax ?? null,
    mgAmount: condition.mgAmount ?? null,
    agAmount: condition.advanceAmount ?? null,
    reportingCycle: nullable(condition.reportingCycle),
    paymentTerms: nullable(condition.paymentTerms),
    royaltyBase: nullable(condition.royaltyBase),
    incoterms: nullable(condition.incoterms),
    minimumQuantity: condition.minimumQuantity ?? null,
    sellOffMonths: parseSellOffMonths(condition.sellOffPeriod),
    withholdingTaxTreatment: nullable(condition.withholdingTaxTreatment),
    notes: nullable(condition.notes)
  };
}

function numericIdentifier(value: string, requiredPrefix?: string) {
  const parts = value.split(":");
  const raw = parts.length === 2 ? parts[1] : parts[0];
  if (requiredPrefix && parts.length === 2 && parts[0] !== requiredPrefix) {
    throw new Error(`Expected ${requiredPrefix} identifier`);
  }
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Invalid numeric identifier");
  return id;
}

function nullable(value: string | undefined) {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}

export function parseSellOffMonths(value: string | undefined) {
  const normalized = value?.trim() ?? "";
  if (!normalized) return null;
  if (normalized === "半年") return 6;
  // 表記ゆれ（ヶ/ヵ/カ/ケ/箇月・月のみ・N months）を広く受理する（監査：不一致は確認後に500だった）
  const match = normalized.match(/^(?:終了後)?\s*(\d+)\s*(?:か月|ヶ月|ヵ月|カ月|ケ月|箇月|月|months?)\s*(?:間)?$/i);
  if (!match) throw new Error("Sell-Off period must be expressed in months");
  return Number(match[1]);
}
