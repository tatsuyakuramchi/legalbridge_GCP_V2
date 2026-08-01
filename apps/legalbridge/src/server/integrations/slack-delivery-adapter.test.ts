import assert from "node:assert/strict";
import test from "node:test";
import {
  DisabledSlackDeliveryAdapter,
  MemorySlackDeliveryAdapter,
  dispatchSlackNotification
} from "./slack-delivery-adapter.js";
import { MemorySlackNotificationHistoryRepository } from "./slack-history-repository.js";
import type { SlackDryRunEnvelope } from "./slack-dry-run.js";

const fingerprint = "a".repeat(64);

function envelope(): SlackDryRunEnvelope {
  return {
    matterId: 10,
    issueKey: "LEGAL-10",
    fingerprint,
    readiness: "ready_for_review",
    readinessLabel: "送信内容を確認可能",
    blockingReasons: [],
    target: {
      kind: "direct_message",
      resolution: "resolved",
      recipientEmailMasked: "ta***@arclight.co.jp",
      userId: "U08217X0A07"
    },
    message: {
      headline: "内容を確認してください",
      body: "法務から確認依頼があります。",
      nextAction: "LegalBridgeで内容を確認してください",
      actions: [{
        id: "open_document",
        label: "内容を確認",
        url: "https://legalbridge-v2-test.arclight.co.jp/documents/10",
        style: "primary"
      }]
    },
    plannedHistoryEntry: {
      matterId: 10,
      issueKey: "LEGAL-10",
      fingerprint,
      requesterStatus: "requester_confirmation",
      outcome: "sent",
      headline: "内容を確認してください",
      triggerDetail: "依頼者確認",
      slackChannelId: null,
      slackMessageTs: null,
      recordedBy: "dry-run"
    },
    externalSend: false,
    historyAppend: false
  };
}

function settings(overrides: Record<string, unknown> = {}) {
  return {
    integrationMode: "live" as const,
    slackCapabilityEnabled: true,
    historyConnected: true,
    approvedFingerprint: fingerprint,
    ...overrides
  };
}

test("local環境ではアダプターを呼ばず送信を停止する", async () => {
  const adapter = new MemorySlackDeliveryAdapter();
  const history = new MemorySlackNotificationHistoryRepository();
  const result = await dispatchSlackNotification({
    envelope: envelope(),
    gateSettings: settings({ integrationMode: "local" }),
    adapter,
    history,
    recordedBy: "admin@arclight.co.jp"
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.externalSend, false);
  assert.deepEqual(adapter.requests, []);
  assert.deepEqual(await history.list(["LEGAL-10"]), []);
});

test("無効アダプターでは送信を停止する", async () => {
  const result = await dispatchSlackNotification({
    envelope: envelope(),
    gateSettings: settings(),
    adapter: new DisabledSlackDeliveryAdapter(),
    history: new MemorySlackNotificationHistoryRepository(),
    recordedBy: "admin@arclight.co.jp"
  });
  assert.equal(result.status, "blocked");
  assert.ok(result.gate.blockers.includes("adapter_unavailable"));
});

test("送信成功後だけ通知履歴を追記する", async () => {
  const adapter = new MemorySlackDeliveryAdapter();
  const history = new MemorySlackNotificationHistoryRepository();
  const result = await dispatchSlackNotification({
    envelope: envelope(),
    gateSettings: settings(),
    adapter,
    history,
    recordedBy: "admin@arclight.co.jp"
  });
  assert.equal(result.status, "sent");
  assert.equal(adapter.requests.length, 1);
  assert.equal(adapter.requests[0].idempotencyKey, fingerprint);
  const records = await history.list(["LEGAL-10"]);
  assert.equal(records.length, 1);
  assert.equal(records[0].fingerprint, fingerprint);
});

test("送信直前に同一指紋の履歴があれば重複送信しない", async () => {
  const adapter = new MemorySlackDeliveryAdapter();
  const history = new MemorySlackNotificationHistoryRepository([{
    issueKey: "LEGAL-10",
    fingerprint,
    outcome: "sent",
    recordedAt: "2026-08-01T00:00:00.000Z"
  }]);
  const result = await dispatchSlackNotification({
    envelope: envelope(),
    gateSettings: settings(),
    adapter,
    history,
    recordedBy: "admin@arclight.co.jp"
  });
  assert.equal(result.status, "duplicate");
  assert.deepEqual(adapter.requests, []);
});

test("Slack API失敗時は通知履歴を追記しない", async () => {
  const adapter = new MemorySlackDeliveryAdapter(
    { channelId: "D0123456789", messageTs: "1785580000.000100" },
    new Error("Slack API unavailable")
  );
  const history = new MemorySlackNotificationHistoryRepository();
  await assert.rejects(
    dispatchSlackNotification({
      envelope: envelope(),
      gateSettings: settings(),
      adapter,
      history,
      recordedBy: "admin@arclight.co.jp"
    }),
    /Slack API unavailable/
  );
  assert.deepEqual(await history.list(["LEGAL-10"]), []);
});

test("不正な送信結果は履歴へ記録しない", async () => {
  const adapter = new MemorySlackDeliveryAdapter({
    channelId: "",
    messageTs: "invalid"
  });
  const history = new MemorySlackNotificationHistoryRepository();
  await assert.rejects(
    dispatchSlackNotification({
      envelope: envelope(),
      gateSettings: settings(),
      adapter,
      history,
      recordedBy: "admin@arclight.co.jp"
    }),
    /invalid delivery receipt/
  );
  assert.deepEqual(await history.list(["LEGAL-10"]), []);
});
