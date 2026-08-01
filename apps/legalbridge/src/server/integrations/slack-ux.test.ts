import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSlackNotificationPreview,
  requesterStatus,
  requesterDeepLink,
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


test("Slackリンクは依頼者が利用できる下書き・文書画面へ直接遷移する", () => {
  const base = "https://legalbridge.example/";
  const information = new URL(requesterDeepLink(base, "information_required", "LEGAL-200"));
  const completed = new URL(requesterDeepLink(base, "completed", "LEGAL-201"));
  const intake = new URL(requesterDeepLink(base, "intake", "LEGAL-202"));

  assert.equal(information.searchParams.get("view"), "drafts");
  assert.equal(information.searchParams.get("issue"), "LEGAL-200");
  assert.equal(completed.searchParams.get("view"), "documents");
  assert.equal(completed.searchParams.get("issue"), "LEGAL-201");
  assert.equal(intake.searchParams.get("view"), "home");
  assert.equal(intake.searchParams.get("issue"), "LEGAL-202");

  for (const item of slackUxPreviewCatalog(base)) {
    assert.notEqual(new URL(item.actions[0].url).searchParams.get("view"), "matters");
  }
});
