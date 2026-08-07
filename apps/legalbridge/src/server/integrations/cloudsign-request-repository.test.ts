import assert from "node:assert/strict";
import test from "node:test";
import { MemoryCloudSignRequestRepository } from "./cloudsign-request-repository.js";

const input = (over: Partial<{ idempotencyKey: string; cloudSignDocumentId: string }> = {}) => ({
  idempotencyKey: over.idempotencyKey ?? "e".repeat(64),
  documentId: 5,
  cloudSignDocumentId: over.cloudSignDocumentId ?? "cs-1",
  status: "sent",
  participantCount: 2,
  recordedBy: "legal@arclight.co.jp"
});

test("未記録キーは null", async () => {
  const repo = new MemoryCloudSignRequestRepository();
  assert.equal(await repo.findByKey("f".repeat(64)), null);
});

test("record は記録し findByKey で取得できる", async () => {
  const repo = new MemoryCloudSignRequestRepository();
  const rec = await repo.record(input());
  assert.equal(rec.cloudSignDocumentId, "cs-1");
  assert.equal((await repo.findByKey("e".repeat(64)))?.participantCount, 2);
});

test("同一キーの再記録は既存を返す（多重化しない）", async () => {
  const repo = new MemoryCloudSignRequestRepository();
  await repo.record(input({ cloudSignDocumentId: "cs-1" }));
  const again = await repo.record(input({ cloudSignDocumentId: "cs-2" }));
  assert.equal(again.cloudSignDocumentId, "cs-1");
  assert.equal((await repo.list()).length, 1);
});

test("updateStatus は cloudSignDocumentId で締結状況を反映する", async () => {
  const repo = new MemoryCloudSignRequestRepository();
  await repo.record(input());
  const updated = await repo.updateStatus("cs-1", "completed");
  assert.equal(updated?.status, "completed");
  assert.equal(await repo.updateStatus("cs-unknown", "completed"), null);
});

// 宛先allowlist純関数（cloudsign-adapter）。
import { parseAllowedRecipients, findDisallowedRecipient } from "./cloudsign-adapter.js";

test("parseAllowedRecipients はカンマ区切りを小文字集合にする", () => {
  const set = parseAllowedRecipients(" A@Example.com , b@example.com ,");
  assert.equal(set.has("a@example.com"), true);
  assert.equal(set.has("b@example.com"), true);
  assert.equal(set.size, 2);
});

test("findDisallowedRecipient は空allowlistでは常にnull（無制限）", () => {
  assert.equal(findDisallowedRecipient(["x@example.com"], new Set()), null);
});

test("findDisallowedRecipient は最初の許可外を返す（大小無視）", () => {
  const allow = new Set(["a@example.com"]);
  assert.equal(findDisallowedRecipient(["A@example.com"], allow), null);
  assert.equal(findDisallowedRecipient(["a@example.com", "b@example.com"], allow), "b@example.com");
});
