import assert from "node:assert/strict";
import test from "node:test";
import { MemorySlackNotificationApprovalRepository } from "./slack-approval-repository.js";

const base = {
  matterId: 1,
  issueKey: "LEGAL-1",
  fingerprint: "a".repeat(64),
  decision: "approved" as const,
  recordedBy: "admin@arclight.co.jp"
};

test("通知承認を追記し課題ごとの最新判断を返す", async () => {
  const repository = new MemorySlackNotificationApprovalRepository();
  await repository.append(base);
  const records = await repository.listLatest(["LEGAL-1"]);
  assert.equal(records.length, 1);
  assert.equal(records[0].decision, "approved");
  assert.equal(records[0].fingerprint, "a".repeat(64));
});

test("取消しを追記すると以前の承認を無効化する", async () => {
  const repository = new MemorySlackNotificationApprovalRepository();
  await repository.append(base);
  await repository.append({ ...base, decision: "revoked" });
  const records = await repository.listLatest(["LEGAL-1"]);
  assert.equal(records.length, 1);
  assert.equal(records[0].decision, "revoked");
});

test("別課題の承認を混在させず指定課題だけ返す", async () => {
  const repository = new MemorySlackNotificationApprovalRepository();
  await repository.append(base);
  await repository.append({ ...base, matterId: 2, issueKey: "LEGAL-2" });
  const records = await repository.listLatest(["LEGAL-2"]);
  assert.deepEqual(records.map((item) => item.issueKey), ["LEGAL-2"]);
});
