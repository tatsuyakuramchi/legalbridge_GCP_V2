// 受領・分配 → payments 台帳同期の「意図（intent）」を算出する純関数。
// SQL 実行（Pg）とメモリ模擬（テスト）で共有し、ロジックを1箇所に集約する。
//
// V1 workModel.ts の syncReceiptPayment / syncDistributionPayment に倣う：
//   - 受領（received_amount）→ 入金台帳 inbound / sublicense_income
//   - 分配（computed_distribution_ex_tax）→ 出金台帳 outbound / royalty（相手=親ライセンサー）
// no-DELETE 不変条件：クリア時は DELETE せず金額ゼロの UPDATE（action='zero'）にする。
// payments の CHECK (work_id IS NOT NULL OR department_code IS NOT NULL) を満たせない
//   （work_id が無い）場合はその台帳同期をスキップする。

export type PaymentIntentKind = "inbound" | "outbound";

export interface PaymentIntent {
  kind: PaymentIntentKind;
  action: "upsert" | "zero";
  /** 既存の payments.id（受領行が保持）。null なら新規 INSERT。 */
  existingPaymentId: number | null;
  paymentNo: string;              // 新規INSERT時の一意番号
  direction: "inbound" | "outbound";
  paymentKind: "sublicense_income" | "royalty";
  workId: number;
  counterpartyVendorId: number | null;
  period: string | null;
  amountExTax: number;
  currency: string;
  status: "received" | "calculated";
  paidDate: string | null;
  sourceDocumentNumber: string;
}

export interface PaymentSyncContext {
  receiptId: number;
  workId: number | null;
  currency: string | null;
  // 受領（inbound）
  receivedAmount: number | null;
  receivedDate: string | null;
  counterpartyVendorId: number | null;
  existingPaymentId: number | null;
  // 分配（outbound）
  distribution: number | null;
  parentCounterpartyVendorId: number | null;
  parentCurrency: string | null;
  existingDistributionPaymentId: number | null;
  period: string | null;
}

function nonZero(value: number | null | undefined): boolean {
  return value != null && Number(value) !== 0;
}

export function planPaymentSync(ctx: PaymentSyncContext): PaymentIntent[] {
  const intents: PaymentIntent[] = [];
  // payments の CHECK を満たせない（作品未リンク）ときは同期しない。
  if (ctx.workId == null) return intents;
  const workId = ctx.workId;

  // ── 受領 → 入金（inbound / sublicense_income） ──
  if (nonZero(ctx.receivedAmount)) {
    intents.push({
      kind: "inbound",
      action: "upsert",
      existingPaymentId: ctx.existingPaymentId,
      paymentNo: `SLRCV-${ctx.receiptId}`,
      direction: "inbound",
      paymentKind: "sublicense_income",
      workId,
      counterpartyVendorId: ctx.counterpartyVendorId,
      period: ctx.period,
      amountExTax: Number(ctx.receivedAmount),
      currency: ctx.currency || "JPY",
      status: "received",
      paidDate: ctx.receivedDate,
      sourceDocumentNumber: `condition_receipt#${ctx.receiptId}`
    });
  } else if (ctx.existingPaymentId != null) {
    intents.push(zeroIntent("inbound", "sublicense_income", ctx.existingPaymentId, workId, ctx.period, ctx.currency || "JPY", "received", `condition_receipt#${ctx.receiptId}`, `SLRCV-${ctx.receiptId}`, ctx.counterpartyVendorId, ctx.receivedDate));
  }

  // ── 分配 → 出金（outbound / royalty・相手=親ライセンサー） ──
  const distributable = nonZero(ctx.distribution) && ctx.parentCounterpartyVendorId != null;
  if (distributable) {
    intents.push({
      kind: "outbound",
      action: "upsert",
      existingPaymentId: ctx.existingDistributionPaymentId,
      paymentNo: `DISTR-${ctx.receiptId}`,
      direction: "outbound",
      paymentKind: "royalty",
      workId,
      counterpartyVendorId: ctx.parentCounterpartyVendorId,
      period: ctx.period,
      amountExTax: Number(ctx.distribution),
      currency: ctx.parentCurrency || ctx.currency || "JPY",
      status: "calculated",
      paidDate: null,
      sourceDocumentNumber: `condition_receipt#${ctx.receiptId}/distribution`
    });
  } else if (ctx.existingDistributionPaymentId != null) {
    intents.push(zeroIntent("outbound", "royalty", ctx.existingDistributionPaymentId, workId, ctx.period, ctx.parentCurrency || ctx.currency || "JPY", "calculated", `condition_receipt#${ctx.receiptId}/distribution`, `DISTR-${ctx.receiptId}`, ctx.parentCounterpartyVendorId, null));
  }

  return intents;
}

function zeroIntent(
  kind: PaymentIntentKind,
  paymentKind: "sublicense_income" | "royalty",
  existingPaymentId: number,
  workId: number,
  period: string | null,
  currency: string,
  status: "received" | "calculated",
  sourceDocumentNumber: string,
  paymentNo: string,
  counterpartyVendorId: number | null,
  paidDate: string | null
): PaymentIntent {
  return {
    kind, action: "zero", existingPaymentId, paymentNo,
    direction: kind, paymentKind, workId, counterpartyVendorId,
    period, amountExTax: 0, currency, status, paidDate, sourceDocumentNumber
  };
}
