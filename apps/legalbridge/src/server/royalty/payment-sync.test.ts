import assert from "node:assert/strict";
import test from "node:test";
import { planPaymentSync, type PaymentSyncContext } from "./payment-sync.js";

function ctx(over: Partial<PaymentSyncContext>): PaymentSyncContext {
  return {
    receiptId: 7, workId: 42, currency: "JPY",
    receivedAmount: null, receivedDate: null, counterpartyVendorId: 18, existingPaymentId: null,
    distribution: null, parentCounterpartyVendorId: 9, parentCurrency: null, existingDistributionPaymentId: null,
    period: "2026-08", ...over
  };
}

test("受領があれば入金台帳へupsert（inbound/sublicense_income）", () => {
  const intents = planPaymentSync(ctx({ receivedAmount: 9000, receivedDate: "2026-08-31" }));
  const inbound = intents.find((i) => i.kind === "inbound");
  assert.ok(inbound);
  assert.equal(inbound?.action, "upsert");
  assert.equal(inbound?.direction, "inbound");
  assert.equal(inbound?.paymentKind, "sublicense_income");
  assert.equal(inbound?.amountExTax, 9000);
  assert.equal(inbound?.paymentNo, "SLRCV-7");
  assert.equal(inbound?.status, "received");
});

test("分配があれば出金台帳へupsert（outbound/royalty・相手=親）", () => {
  const intents = planPaymentSync(ctx({ distribution: 2000, parentCounterpartyVendorId: 9, parentCurrency: "USD" }));
  const outbound = intents.find((i) => i.kind === "outbound");
  assert.ok(outbound);
  assert.equal(outbound?.direction, "outbound");
  assert.equal(outbound?.paymentKind, "royalty");
  assert.equal(outbound?.counterpartyVendorId, 9);
  assert.equal(outbound?.currency, "USD");
  assert.equal(outbound?.amountExTax, 2000);
  assert.equal(outbound?.paymentNo, "DISTR-7");
  assert.equal(outbound?.status, "calculated");
});

test("受領クリア時は既存台帳を金額ゼロUPDATE（no-DELETE）", () => {
  const intents = planPaymentSync(ctx({ receivedAmount: null, existingPaymentId: 55 }));
  const inbound = intents.find((i) => i.kind === "inbound");
  assert.equal(inbound?.action, "zero");
  assert.equal(inbound?.existingPaymentId, 55);
  assert.equal(inbound?.amountExTax, 0);
});

test("親未リンク（分配相手なし）は出金同期しない", () => {
  const intents = planPaymentSync(ctx({ distribution: 2000, parentCounterpartyVendorId: null }));
  assert.equal(intents.find((i) => i.kind === "outbound"), undefined);
});

test("作品未リンク（work_id null）はCHECK不成立のため一切同期しない", () => {
  const intents = planPaymentSync(ctx({ workId: null, receivedAmount: 9000, distribution: 2000 }));
  assert.equal(intents.length, 0);
});

test("受領・分配ともにあれば2件（inbound+outbound）", () => {
  const intents = planPaymentSync(ctx({ receivedAmount: 9000, distribution: 2000 }));
  assert.equal(intents.length, 2);
});
