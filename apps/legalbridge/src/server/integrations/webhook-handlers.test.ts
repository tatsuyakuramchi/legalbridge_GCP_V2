import assert from "node:assert/strict";
import test from "node:test";
import { createCloudSignWebhookHandler, createBacklogWebhookHandler } from "./webhook-handlers.js";
import {
  parseCloudSignEvent, parseBacklogIssueCreated, parseBacklogStatusChanged, extractSlackMention
} from "../internal/webhook-parsers.js";
import { MemorySlackIntakeRepository } from "../slack-intake/intake-repository.js";
import { MemoryWebhookReceiptsRepository } from "../internal/webhook-receipts-repository.js";
import { MemoryCloudSignRequestRepository, type CloudSignRequestRecord } from "./cloudsign-request-repository.js";
import { MemoryContractStatusWriter } from "../documents/contract-status-writer.js";

// ---- parsers ----
test("parseCloudSignEvent: 締結/却下/確認中/不明", () => {
  assert.equal(parseCloudSignEvent({ documentID: "cs1", status: 2 })?.status, "completed");
  assert.equal(parseCloudSignEvent({ documentID: "cs1", status: 3 })?.status, "declined");
  assert.equal(parseCloudSignEvent({ documentID: "cs1", status: 1 })?.status, "sent");
  assert.equal(parseCloudSignEvent({ documentID: "cs1", text: "COMPLETED : ok" })?.status, "completed");
  assert.equal(parseCloudSignEvent({ status: 2 }), null); // documentID 無し
  assert.equal(parseCloudSignEvent("nope"), null);
});

test("parseBacklogIssueCreated: type=1 のみ・issueKey 合成", () => {
  assert.deepEqual(parseBacklogIssueCreated({
    type: 1, project: { projectKey: "LB" },
    content: { key_id: 42, summary: "審査", description: "詳細 <@U123>", issueType: { name: "NDA" } }
  }), { issueKey: "LB-42", summary: "審査", description: "詳細 <@U123>", issueTypeName: "NDA" });
  assert.equal(parseBacklogIssueCreated({ type: 2, project: { projectKey: "LB" }, content: { key_id: 42 } }), null); // 更新は対象外
  assert.equal(parseBacklogIssueCreated({ type: 1, content: { key_id: 42 } }), null); // projectKey 無し
});

test("parseBacklogStatusChanged: type=2 かつ status.name のあるもののみ", () => {
  assert.deepEqual(parseBacklogStatusChanged({
    type: 2, project: { projectKey: "LB" }, content: { key_id: 42, status: { name: "処理中" } }
  }), { issueKey: "LB-42", status: "処理中" });
  assert.equal(parseBacklogStatusChanged({ type: 2, project: { projectKey: "LB" }, content: { key_id: 42 } }), null);
  assert.equal(parseBacklogStatusChanged({ type: 1, project: { projectKey: "LB" }, content: { key_id: 42, status: { name: "x" } } }), null);
});

test("extractSlackMention: 説明文からメンション抽出", () => {
  assert.equal(extractSlackMention("依頼者: <@U0ABC123>\n詳細"), "U0ABC123");
  assert.equal(extractSlackMention("メンションなし"), "");
});

// ---- CloudSign handler ----
function csRecord(over: Partial<CloudSignRequestRecord> = {}): CloudSignRequestRecord {
  return {
    idempotencyKey: "k", documentId: 100, cloudSignDocumentId: "cs1", status: "sent",
    participantCount: 1, recordedAt: "2026-08-01T00:00:00Z", recordedBy: "sys", ...over
  };
}

test("cloudsign: 締結で status 更新＋契約 executed、二重送信は skip", async () => {
  const receipts = new MemoryWebhookReceiptsRepository();
  const requests = new MemoryCloudSignRequestRepository([csRecord()]);
  const contract = new MemoryContractStatusWriter();
  const handler = createCloudSignWebhookHandler({ receipts, requests, contract });

  const first = await handler({ documentID: "cs1", status: 2 }, {});
  assert.equal((first.body as any).status, "completed");
  assert.equal((first.body as any).documentId, 100);
  assert.equal((first.body as any).contractExecuted, 1);
  assert.deepEqual(contract.executed, [100]);

  const dup = await handler({ documentID: "cs1", status: 2 }, {});
  assert.equal((dup.body as any).skipped, "duplicate");
  assert.deepEqual(contract.executed, [100]); // 再実行されない
});

test("cloudsign: 未知ドキュメントは skip（副作用なし）", async () => {
  const handler = createCloudSignWebhookHandler({
    receipts: new MemoryWebhookReceiptsRepository(),
    requests: new MemoryCloudSignRequestRepository([]),
    contract: new MemoryContractStatusWriter()
  });
  const res = await handler({ documentID: "unknown", status: 2 }, {});
  assert.equal((res.body as any).skipped, "unknown document");
});

test("cloudsign: 契約更新の権限不足は forbidden で受信自体は成功", async () => {
  const handler = createCloudSignWebhookHandler({
    receipts: new MemoryWebhookReceiptsRepository(),
    requests: new MemoryCloudSignRequestRepository([csRecord()]),
    contract: new MemoryContractStatusWriter(true /* forbidden */)
  });
  const res = await handler({ documentID: "cs1", status: 2 }, {});
  assert.equal(res.status, 200);
  assert.equal((res.body as any).contractForbidden, true);
});

test("cloudsign: 判別不能ペイロードは 200 skip", async () => {
  const handler = createCloudSignWebhookHandler({
    receipts: new MemoryWebhookReceiptsRepository(),
    requests: new MemoryCloudSignRequestRepository([]),
    contract: new MemoryContractStatusWriter()
  });
  const res = await handler({ foo: "bar" }, {});
  assert.equal((res.body as any).skipped, "unparseable");
});

// ---- Backlog handler ----
test("backlog: 課題追加で通知、二重は skip", async () => {
  const receipts = new MemoryWebhookReceiptsRepository();
  const posted: string[] = [];
  const handler = createBacklogWebhookHandler({ receipts, notify: async (t) => { posted.push(t); return true; } });

  const first = await handler({ type: 1, project: { projectKey: "LB" }, content: { key_id: 7, summary: "相談" } }, {});
  assert.equal((first.body as any).issueKey, "LB-7");
  assert.equal((first.body as any).notified, true);
  assert.equal(posted.length, 1);
  assert.match(posted[0], /LB-7/);

  const dup = await handler({ type: 1, project: { projectKey: "LB" }, content: { key_id: 7 } }, {});
  assert.equal((dup.body as any).skipped, "duplicate");
  assert.equal(posted.length, 1);
});

test("backlog: type!=1 は無視", async () => {
  const handler = createBacklogWebhookHandler({ receipts: new MemoryWebhookReceiptsRepository() });
  const res = await handler({ type: 2, project: { projectKey: "LB" }, content: { key_id: 7 } }, {});
  assert.equal((res.body as any).skipped, "ignored");
});

// ---- Backlog 自動起票（9-7 完成形） ----
function createdEvent(over: Record<string, unknown> = {}) {
  return {
    type: 1, project: { projectKey: "LB" },
    content: {
      key_id: 8, summary: "NDA審査をお願いします",
      description: "詳細です <@U0REQ1>", issueType: { name: "NDA" }, ...over
    }
  };
}

test("backlog自動起票: 新規課題 → legal_requests 作成（種別マップ＋メンション＋notes）", async () => {
  const intake = new MemorySlackIntakeRepository();
  const handler = createBacklogWebhookHandler({ receipts: new MemoryWebhookReceiptsRepository(), intake });
  const res = await handler(createdEvent(), {});
  assert.equal((res.body as any).intakeCreated, true);
  assert.equal((res.body as any).accepted, false);
  assert.equal(intake.requests.length, 1);
  assert.equal(intake.requests[0].backlogIssueKey, "LB-8");
  assert.equal(intake.requests[0].requestType, "nda");
  assert.equal(intake.requests[0].slackUserId, "U0REQ1");
  const notes = JSON.parse(intake.requests[0].notes ?? "{}");
  assert.equal(notes.source, "backlog-webhook");
  assert.equal(notes.issueTypeName, "NDA");
});

test("backlog自動起票: 未知の課題種別は legal_consult に縮退", async () => {
  const intake = new MemorySlackIntakeRepository();
  const handler = createBacklogWebhookHandler({ receipts: new MemoryWebhookReceiptsRepository(), intake });
  await handler(createdEvent({ issueType: { name: "謎の種別" } }), {});
  assert.equal(intake.requests[0].requestType, "legal_consult");
});

test("backlog自動起票: 既存依頼（Slack経由）は受付済みへ・INSERTしない", async () => {
  const intake = new MemorySlackIntakeRepository();
  intake.candidates.push({ slackUserId: "U0REQ1", requestType: "nda", issueKey: "LB-8", summary: "s", counterparty: null });
  const handler = createBacklogWebhookHandler({ receipts: new MemoryWebhookReceiptsRepository(), intake });
  const res = await handler(createdEvent(), {});
  assert.equal((res.body as any).accepted, true);
  assert.equal((res.body as any).intakeCreated, false);
  assert.equal(intake.requests.length, 0);
  assert.equal(intake.workflowStatuses.get("LB-8"), "受付済み");
});

test("backlog自動起票: ステータス変更(type=2)でワークフロー同期", async () => {
  const intake = new MemorySlackIntakeRepository();
  const handler = createBacklogWebhookHandler({ receipts: new MemoryWebhookReceiptsRepository(), intake });
  const res = await handler({ type: 2, project: { projectKey: "LB" }, content: { key_id: 8, status: { name: "処理中" } } }, {});
  assert.equal((res.body as any).statusSynced, "処理中");
  assert.equal(intake.workflowStatuses.get("LB-8"), "処理中");
});

test("backlog自動起票: intake 未注入なら type=2 は skip（従来挙動）", async () => {
  const handler = createBacklogWebhookHandler({ receipts: new MemoryWebhookReceiptsRepository() });
  const res = await handler({ type: 2, project: { projectKey: "LB" }, content: { key_id: 8, status: { name: "処理中" } } }, {});
  assert.equal((res.body as any).skipped, "intake disabled");
});

test("backlog自動起票: 権限未整備(42501)でも受信は成功（forbidden 計上・通知は継続）", async () => {
  const intake = new MemorySlackIntakeRepository(new Map(), new Map(), true /* forbidden */);
  const posted: string[] = [];
  const handler = createBacklogWebhookHandler({
    receipts: new MemoryWebhookReceiptsRepository(), intake,
    notify: async (t) => { posted.push(t); return true; }
  });
  const res = await handler(createdEvent(), {});
  assert.equal(res.status, 200);
  assert.equal((res.body as any).forbidden, true);
  assert.equal((res.body as any).intakeCreated, false);
  assert.equal(posted.length, 1);
  const sync = await handler({ type: 2, project: { projectKey: "LB" }, content: { key_id: 8, status: { name: "完了" } } }, {});
  assert.equal(sync.status, 200);
  assert.equal((sync.body as any).forbidden, true);
});
