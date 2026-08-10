import assert from "node:assert/strict";
import test from "node:test";
import { createCloudSignWebhookHandler, createBacklogWebhookHandler } from "./webhook-handlers.js";
import { parseCloudSignEvent, parseBacklogIssueCreated } from "../internal/webhook-parsers.js";
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
  assert.deepEqual(parseBacklogIssueCreated({ type: 1, project: { projectKey: "LB" }, content: { key_id: 42, summary: "審査" } }),
    { issueKey: "LB-42", summary: "審査" });
  assert.equal(parseBacklogIssueCreated({ type: 2, project: { projectKey: "LB" }, content: { key_id: 42 } }), null); // 更新は対象外
  assert.equal(parseBacklogIssueCreated({ type: 1, content: { key_id: 42 } }), null); // projectKey 無し
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
