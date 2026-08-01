import assert from "node:assert/strict";
import test from "node:test";
import type { MatterSummary } from "../matters/repository.js";
import { buildSlackNotificationCandidates } from "./slack-candidates.js";
import {
  evaluateSlackCandidates,
  notificationFingerprint
} from "./slack-deduplication.js";

function candidate(stage = "completed") {
  const matter: MatterSummary = {
    id: 1,
    matterCode: "MTR-1",
    title: "契約確認",
    status: "in_progress",
    counterparty: "取引先",
    primaryIssueKey: "LEGAL-1",
    lifecycleStage: stage,
    ownerName: null,
    targetDueDate: null,
    blockedReason: null,
    issueCount: 1,
    documentCount: 1,
    openTaskCount: 0,
    nextTaskTitle: null,
    nextTaskDueAt: null,
    updatedAt: "2026-08-01T00:00:00.000Z"
  };
  return buildSlackNotificationCandidates(
    [matter],
    "https://legalbridge.example/"
  )[0];
}

test("同じ案件状態と必要行動から同じ通知指紋を生成する", () => {
  const first = candidate();
  const second = candidate();
  assert.equal(notificationFingerprint(first), notificationFingerprint(second));
});

test("通知済みの同一指紋を重複として抑止する", () => {
  const target = candidate();
  const fingerprint = notificationFingerprint(target);
  const evaluated = evaluateSlackCandidates([target], [{
    issueKey: target.issueKey,
    fingerprint,
    outcome: "sent",
    recordedAt: "2026-08-01T01:00:00.000Z"
  }]);

  assert.equal(evaluated[0].eligibility, "duplicate");
  assert.equal(evaluated[0].previousNotificationAt, "2026-08-01T01:00:00.000Z");
});

test("履歴未接続では通知対象を送信可能にしない", () => {
  const target = candidate();
  const evaluated = evaluateSlackCandidates([target], null);
  assert.equal(evaluated[0].eligibility, "history_unavailable");

  const quiet = evaluateSlackCandidates([candidate("internal_review")], null);
  assert.equal(quiet[0].eligibility, "quiet");
});
