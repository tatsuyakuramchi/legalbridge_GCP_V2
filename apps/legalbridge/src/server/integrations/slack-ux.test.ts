import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSlackNotificationPreview,
  requesterStatus,
  slackUxPreviewCatalog
} from "./slack-ux.js";

test("Backlog内部工程を利用者向けの七段階へ変換する", () => {
  assert.equal(requesterStatus({ lifecycleStage: "triage" }), "intake");
  assert.equal(requesterStatus({ lifecycleStage: "internal_review" }), "legal_review");
  assert.equal(requesterStatus({ lifecycleStage: "signing" }), "execution");
  assert.equal(requesterStatus({ lifecycleStage: "completed" }), "completed");
  assert.equal(requesterStatus({ lifecycleStage: "cancelled" }), "withdrawn");
});

test("依頼者の行動が必要な通知へ現在地・次の行動・ボタンを付ける", () => {
  const preview = buildSlackNotificationPreview({
    issueKey: "LEGAL-100",
    title: "業務委託契約書の作成",
    lifecycleStage: "internal_review",
    needsRequesterInput: true,
    legalBridgeUrl: "https://legalbridge.example/request/LEGAL-100"
  });

  assert.equal(preview.requesterStatus, "information_required");
  assert.equal(preview.shouldNotify, true);
  assert.equal(preview.delivery.newRootMessage, false);
  assert.equal(preview.delivery.useExistingMatterThread, true);
  assert.equal(preview.actions[0].id, "add_information");
  assert.match(preview.nextAction, /不足情報を入力/);
});

test("管理画面用プレビューは七状態を外部送信せず比較できる", () => {
  const catalog = slackUxPreviewCatalog();
  assert.equal(catalog.length, 7);
  assert.deepEqual(
    catalog.map((item) => item.requesterStatus),
    [
      "intake",
      "information_required",
      "legal_review",
      "requester_review",
      "execution",
      "completed",
      "withdrawn"
    ]
  );
});
