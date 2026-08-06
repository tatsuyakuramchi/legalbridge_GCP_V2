import assert from "node:assert/strict";
import test from "node:test";
import { MemoryGmailSendHistoryRepository } from "./gmail-send-history-repository.js";

const entry = (over: Partial<{ idempotencyKey: string; messageId: string }> = {}) => ({
  idempotencyKey: over.idempotencyKey ?? "a".repeat(64),
  documentId: 7,
  recipient: "to@example.com",
  messageId: over.messageId ?? "m1",
  threadId: "t1",
  recordedBy: "legal@arclight.co.jp"
});

test("未送信キーは null を返す", async () => {
  const repo = new MemoryGmailSendHistoryRepository();
  assert.equal(await repo.findByKey("x".repeat(64)), null);
});

test("記録後は findByKey が受領情報を返す", async () => {
  const repo = new MemoryGmailSendHistoryRepository();
  await repo.record(entry());
  const found = await repo.findByKey("a".repeat(64));
  assert.equal(found?.messageId, "m1");
  assert.equal(found?.threadId, "t1");
  assert.match(found?.recordedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
});

test("同一キーの再記録は多重化しない（ON CONFLICT DO NOTHING相当）", async () => {
  const repo = new MemoryGmailSendHistoryRepository();
  await repo.record(entry({ messageId: "m1" }));
  await repo.record(entry({ messageId: "m2" }));
  const found = await repo.findByKey("a".repeat(64));
  // 最初の記録が保持される（重複は無視）。
  assert.equal(found?.messageId, "m1");
});
