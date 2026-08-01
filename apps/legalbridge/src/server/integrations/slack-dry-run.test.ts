import assert from "node:assert/strict";
import test from "node:test";
import type { MatterSummary } from "../matters/repository.js";
import { buildSlackNotificationCandidates } from "./slack-candidates.js";
import { evaluateSlackCandidates, notificationFingerprint } from "./slack-deduplication.js";
import { buildSlackDryRunQueue } from "./slack-dry-run.js";
import { createSlackRecipientDirectory } from "./slack-recipient-resolver.js";

const resolvedRecipients = createSlackRecipientDirectory(
  "requester@arclight.co.jp=U0123456789"
);

function evaluated(history: "connected" | "missing" = "connected") {
  const matter: MatterSummary = {
    id: 90, matterCode: "MTR-90", title: "契約確認", status: "in_progress",
    counterparty: "取引先", primaryIssueKey: "LEGAL-90", lifecycleStage: "completed",
    ownerName: null, targetDueDate: null, blockedReason: null, issueCount: 1,
    documentCount: 1, openTaskCount: 0, nextTaskTitle: null, nextTaskDueAt: null,
    updatedAt: "2026-08-01T00:00:00.000Z",
    requesterEmail: "requester@arclight.co.jp"
  };
  const candidate = buildSlackNotificationCandidates(
    [matter], "https://legalbridge-v2-test.arclight.co.jp"
  )[0];
  return evaluateSlackCandidates([candidate], history === "connected" ? [] : null)[0];
}

test("送信先・履歴・HTTPSリンクが揃った候補をレビュー可能にする", () => {
  const envelope = buildSlackDryRunQueue([evaluated()], resolvedRecipients)[0];
  assert.equal(envelope.readiness, "ready_for_review");
  assert.equal(envelope.target.userId, "U0123456789");
  assert.equal(envelope.externalSend, false);
  assert.equal(envelope.historyAppend, false);
  assert.equal(envelope.plannedHistoryEntry.recordedBy, "dry-run");
});

test("依頼者とSlackユーザーの対応がない候補を送信可能にしない", () => {
  const envelope = buildSlackDryRunQueue(
    [evaluated()],
    createSlackRecipientDirectory("UNRESOLVED")
  )[0];
  assert.equal(envelope.readiness, "blocked_recipient");
  assert.equal(envelope.target.resolution, "unmapped");
  assert.match(envelope.blockingReasons[0], /Slackユーザー/);
});

test("履歴未接続と通知済み候補を安全側で抑止する", () => {
  const unavailable = buildSlackDryRunQueue([evaluated("missing")], resolvedRecipients)[0];
  assert.equal(unavailable.readiness, "blocked_history");

  const target = evaluated();
  const duplicate = evaluateSlackCandidates([target], [{
    issueKey: target.issueKey,
    fingerprint: notificationFingerprint(target),
    outcome: "sent",
    recordedAt: "2026-08-01T00:00:00.000Z"
  }])[0];
  assert.equal(
    buildSlackDryRunQueue([duplicate], resolvedRecipients)[0].readiness,
    "suppressed_duplicate"
  );
});
