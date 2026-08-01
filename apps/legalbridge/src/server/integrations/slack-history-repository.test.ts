import assert from "node:assert/strict";
import test from "node:test";
import { MemorySlackNotificationHistoryRepository } from "./slack-history-repository.js";

const entry = {
  matterId: 1,
  issueKey: "LEGAL-1",
  fingerprint: "a".repeat(64),
  requesterStatus: "completed" as const,
  outcome: "sent" as const,
  headline: "法務依頼が完了しました",
  recordedBy: "system@test"
};

test("通知履歴を追記して課題キー単位で参照する", async () => {
  const repository = new MemorySlackNotificationHistoryRepository();
  await repository.append(entry);
  const records = await repository.list(["LEGAL-1"]);
  assert.equal(records.length, 1);
  assert.equal(records[0].fingerprint, "a".repeat(64));
  assert.equal((await repository.list(["LEGAL-2"])).length, 0);
});

test("送信済みの同一通知指紋を重複登録しない", async () => {
  const repository = new MemorySlackNotificationHistoryRepository();
  await repository.append(entry);
  await repository.append(entry);
  assert.equal((await repository.list(["LEGAL-1"])).length, 1);
});
