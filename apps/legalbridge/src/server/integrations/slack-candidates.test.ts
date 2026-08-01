import assert from "node:assert/strict";
import test from "node:test";
import type { MatterSummary } from "../matters/repository.js";
import {
  buildSlackNotificationCandidates,
  requesterSignal
} from "./slack-candidates.js";

function matter(patch: Partial<MatterSummary> = {}): MatterSummary {
  return {
    id: 1,
    matterCode: "MTR-1",
    title: "業務委託契約の確認",
    status: "in_progress",
    counterparty: "取引先A",
    primaryIssueKey: "LEGAL-1",
    lifecycleStage: "internal_review",
    ownerName: "法務担当",
    targetDueDate: null,
    blockedReason: null,
    issueCount: 1,
    documentCount: 0,
    openTaskCount: 1,
    nextTaskTitle: null,
    nextTaskDueAt: null,
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...patch
  };
}

test("案件の依頼者向けタスクから追加入力と確認依頼を判定する", () => {
  assert.equal(
    requesterSignal(matter({ blockedReason: "申請者から追加情報の回答待ち" })).trigger,
    "requester_input"
  );
  assert.equal(
    requesterSignal(matter({ nextTaskTitle: "依頼者確認・内容確認" })).trigger,
    "requester_confirmation"
  );
  assert.equal(requesterSignal(matter()).trigger, "lifecycle");
});

test("実案件を通知候補へ変換し通知対象を先頭に並べる", () => {
  const candidates = buildSlackNotificationCandidates([
    matter({ id: 1, primaryIssueKey: "LEGAL-1", lifecycleStage: "internal_review" }),
    matter({
      id: 2,
      primaryIssueKey: "LEGAL-2",
      lifecycleStage: "internal_review",
      blockedReason: "依頼者から追加情報の回答待ち"
    }),
    matter({
      id: 3,
      primaryIssueKey: "LEGAL-3",
      lifecycleStage: "completed"
    }),
    matter({ id: 4, primaryIssueKey: null })
  ], "https://legalbridge.example/");

  assert.equal(candidates.length, 3);
  assert.deepEqual(
    candidates.map((candidate) => candidate.issueKey),
    ["LEGAL-2", "LEGAL-3", "LEGAL-1"]
  );
  assert.equal(candidates[0].notification.requesterStatus, "information_required");
  assert.equal(candidates[0].notification.shouldNotify, true);
  assert.equal(candidates[0].deliveryState, "not_evaluated");
  assert.equal(
    new URL(candidates[0].notification.actions[0].url).searchParams.get("issue"),
    "LEGAL-2"
  );
});
