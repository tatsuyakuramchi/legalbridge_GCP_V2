import assert from "node:assert/strict";
import test from "node:test";
import type { SlackDryRunEnvelope } from "./slack-dry-run.js";
import { evaluateSlackDispatchGate } from "./slack-dispatch-gate.js";

function envelope(readiness: SlackDryRunEnvelope["readiness"] = "ready_for_review"): SlackDryRunEnvelope {
  return {
    matterId: 1,
    issueKey: "LEGAL-1",
    fingerprint: "fingerprint-1",
    readiness,
    readinessLabel: "送信内容を確認可能",
    blockingReasons: [],
    target: {
      kind: "direct_message",
      resolution: "resolved",
      recipientEmailMasked: "re***@arclight.co.jp",
      userId: "U0123456789"
    },
    message: {
      headline: "確認依頼",
      body: "内容を確認してください",
      nextAction: "LegalBridgeで回答してください",
      actions: []
    },
    plannedHistoryEntry: {
      matterId: 1,
      issueKey: "LEGAL-1",
      fingerprint: "fingerprint-1",
      requesterStatus: "requester_review",
      outcome: "sent",
      headline: "確認依頼",
      recordedBy: "dry-run"
    },
    externalSend: false,
    historyAppend: false
  };
}

test("全条件が揃った場合だけ送信条件充足と判定する", () => {
  const result = evaluateSlackDispatchGate(envelope(), {
    integrationMode: "live",
    slackCapabilityEnabled: true,
    historyConnected: true,
    approvedFingerprint: "fingerprint-1",
    adapterConfigured: true
  });
  assert.equal(result.dispatchAllowed, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.externalSend, false);
});

test("現在の検証環境は複数の独立ゲートで送信停止する", () => {
  const result = evaluateSlackDispatchGate(envelope(), {
    integrationMode: "local",
    slackCapabilityEnabled: false,
    historyConnected: true,
    approvedFingerprint: null,
    adapterConfigured: false
  });
  assert.equal(result.dispatchAllowed, false);
  assert.deepEqual(result.blockers, [
    "integration_local",
    "capability_disabled",
    "approval_missing",
    "adapter_unavailable"
  ]);
});

test("承認後に通知指紋が変わった場合は承認を無効化する", () => {
  const result = evaluateSlackDispatchGate(envelope(), {
    integrationMode: "live",
    slackCapabilityEnabled: true,
    historyConnected: true,
    approvedFingerprint: "old-fingerprint",
    adapterConfigured: true
  });
  assert.equal(result.dispatchAllowed, false);
  assert.deepEqual(result.blockers, ["approval_stale"]);
});
