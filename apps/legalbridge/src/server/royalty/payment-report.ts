import { resolveWithholdingEnabled, computeRoyaltyPayment } from "./tax.js";

// 支払報告書の組み立て（純関数・DB非依存）— Phase 1 S4。
// 出金台帳（payments outbound）の各行に源泉徴収・消費税を適用し、差引振込額まで
// を算定する。源泉ロジックは tax.ts（10.21% / 100万超20.42% / 個人強制ON）を再利用。
// V1 excelService.buildFromFormData の源泉・振込額算定を、支払台帳ベースで再構成。

export interface PaymentReportInput {
  paymentId: number;
  vendorName: string | null;
  vendorCode: string | null;
  entityType: string | null;
  vendorWithholdingEnabled: boolean | null;
  invoiceRegistrationNumber: string | null;
  period: string | null;
  currency: string | null;
  amountExTax: number;       // 税抜支払額
  taxRatePct?: number | null;
}

export interface PaymentReportLine {
  paymentId: number;
  vendorName: string;
  vendorCode: string;
  invoiceRegistrationNumber: string;
  period: string;
  currency: string;
  withholdingEnabled: boolean;
  subtotalExTax: number;
  consumptionTax: number;
  taxIncluded: number;
  withholdingTax: number;
  netTransfer: number;
}

export interface PaymentReportTotals {
  subtotalExTax: number;
  consumptionTax: number;
  withholdingTax: number;
  netTransfer: number;
  count: number;
}

export interface PaymentReport {
  lines: PaymentReportLine[];
  totals: PaymentReportTotals;
}

export function buildPaymentReport(inputs: PaymentReportInput[]): PaymentReport {
  const lines = inputs.map<PaymentReportLine>((input) => {
    const withholdingEnabled = resolveWithholdingEnabled({
      vendorWithholdingEnabled: input.vendorWithholdingEnabled,
      entityType: input.entityType
    });
    const breakdown = computeRoyaltyPayment({
      subtotalExTax: input.amountExTax,
      taxRatePct: input.taxRatePct ?? 10,
      withholdingEnabled
    });
    return {
      paymentId: input.paymentId,
      vendorName: input.vendorName ?? "（取引先未設定）",
      vendorCode: input.vendorCode ?? "",
      invoiceRegistrationNumber: input.invoiceRegistrationNumber ?? "",
      period: input.period ?? "",
      currency: input.currency ?? "JPY",
      withholdingEnabled,
      subtotalExTax: breakdown.subtotalExTax,
      consumptionTax: breakdown.consumptionTax,
      taxIncluded: breakdown.taxIncluded,
      withholdingTax: breakdown.withholdingTax,
      netTransfer: breakdown.netTransfer
    };
  });

  const totals = lines.reduce<PaymentReportTotals>((acc, line) => ({
    subtotalExTax: acc.subtotalExTax + line.subtotalExTax,
    consumptionTax: acc.consumptionTax + line.consumptionTax,
    withholdingTax: acc.withholdingTax + line.withholdingTax,
    netTransfer: acc.netTransfer + line.netTransfer,
    count: acc.count + 1
  }), { subtotalExTax: 0, consumptionTax: 0, withholdingTax: 0, netTransfer: 0, count: 0 });

  return { lines, totals };
}
