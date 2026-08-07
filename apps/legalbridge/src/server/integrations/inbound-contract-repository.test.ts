import assert from "node:assert/strict";
import test from "node:test";
import { MemoryInboundContractRepository } from "./inbound-contract-repository.js";

const capture = (over: Partial<{ idempotencyKey: string; filename: string }> = {}) => ({
  idempotencyKey: over.idempotencyKey ?? "b".repeat(64),
  messageId: "m1",
  attachmentId: "att-1",
  threadId: "t1",
  filename: over.filename ?? "c.pdf",
  fromAddress: "cp@example.com",
  subject: "契約書",
  receivedAt: "2026-08-01T00:00:00.000Z",
  capturedBy: "legal@arclight.co.jp"
});

test("未取込キーは null を返す", async () => {
  const repo = new MemoryInboundContractRepository();
  assert.equal(await repo.findByKey("z".repeat(64)), null);
});

test("capture は captured 状態で記録し findByKey で取得できる", async () => {
  const repo = new MemoryInboundContractRepository();
  const rec = await repo.capture(capture());
  assert.equal(rec.status, "captured");
  const found = await repo.findByKey("b".repeat(64));
  assert.equal(found?.filename, "c.pdf");
  assert.equal(found?.driveLink, null);
});

test("同一キーの再取込は既存レコードを返す（多重化しない）", async () => {
  const repo = new MemoryInboundContractRepository();
  await repo.capture(capture({ filename: "first.pdf" }));
  const again = await repo.capture(capture({ filename: "second.pdf" }));
  assert.equal(again.filename, "first.pdf");
  const all = await repo.list();
  assert.equal(all.length, 1);
});

test("list は status で絞り込める", async () => {
  const repo = new MemoryInboundContractRepository();
  await repo.capture(capture({ idempotencyKey: "a".repeat(64) }));
  await repo.capture(capture({ idempotencyKey: "c".repeat(64) }));
  await repo.updateStatus("a".repeat(64), "dismissed");
  assert.equal((await repo.list("captured")).length, 1);
  assert.equal((await repo.list("dismissed")).length, 1);
  assert.equal((await repo.list()).length, 2);
});

test("存在しないキーの updateStatus は null", async () => {
  const repo = new MemoryInboundContractRepository();
  assert.equal(await repo.updateStatus("d".repeat(64), "linked"), null);
});
