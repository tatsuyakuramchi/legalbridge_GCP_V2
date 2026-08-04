import assert from "node:assert/strict";
import test from "node:test";
import { evaluateGmailDispatchGate } from "./gmail-dispatch-gate.js";

const liveSettings = {
  integrationMode: "live" as const,
  gmailCapabilityEnabled: true,
  adapterConfigured: true,
  senderEmail: "legal@arclight.co.jp"
};
const preview = { to: "to@example.com", subject: "件名", bodyText: "本文" };

test("全条件が揃えば送信可能", () => {
  const gate = evaluateGmailDispatchGate(preview, liveSettings);
  assert.equal(gate.dispatchAllowed, true);
  assert.equal(gate.blockers.length, 0);
});

test("ローカルモードはブロックする", () => {
  const gate = evaluateGmailDispatchGate(preview, { ...liveSettings, integrationMode: "local" });
  assert.equal(gate.dispatchAllowed, false);
  assert.ok(gate.blockers.includes("integration_local"));
});

test("能力無効・アダプタ未設定・不正宛先・空本文をブロックする", () => {
  const gate = evaluateGmailDispatchGate(
    { to: "bad", subject: "", bodyText: "" },
    { ...liveSettings, gmailCapabilityEnabled: false, adapterConfigured: false });
  assert.equal(gate.dispatchAllowed, false);
  for (const blocker of ["capability_disabled", "adapter_unavailable", "recipient_invalid", "content_incomplete"] as const) {
    assert.ok(gate.blockers.includes(blocker), blocker);
  }
  assert.equal(gate.externalSend, false);
});
