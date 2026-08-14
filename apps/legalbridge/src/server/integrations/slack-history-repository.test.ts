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

// ── 案件 ↔ Slack スレッドのアンカー（1案件=1スレッド・方針 §5）────────────────
function anchorRepo(rows: Array<Record<string, unknown>>) {
  const repo = new MemorySlackNotificationHistoryRepository();
  rows.forEach((row, index) => repo.seedRow({
    matterId: 1, issueKey: `LEGAL-${index + 1}`, fingerprint: `f${index}`,
    requesterStatus: "in_review", outcome: "sent", headline: `通知${index + 1}`,
    slackChannelId: "D0123456789", slackMessageTs: `178558000${index}.000100`,
    recordedAt: `2026-08-1${index + 1}T00:00:00.000Z`, recordedBy: "test",
    ...row
  } as never));
  return repo;
}

test("アンカー: intake の受付通知を最優先で root にする", async () => {
  const repo = anchorRepo([
    { requesterStatus: "in_review", slackMessageTs: "1785580001.000100", recordedAt: "2026-08-11T00:00:00.000Z" },
    { requesterStatus: "intake", slackMessageTs: "1785580002.000100", recordedAt: "2026-08-13T00:00:00.000Z" }
  ]);
  const anchor = await repo.findMatterThreadAnchor(1);
  assert.equal(anchor?.rootMessageTs, "1785580002.000100");
  assert.equal(anchor?.legacyRootCount, 1);
});

test("アンカー: intake が無ければ最古の有効送信を root にする", async () => {
  const repo = anchorRepo([
    { slackMessageTs: "1785580002.000100", recordedAt: "2026-08-13T00:00:00.000Z" },
    { slackMessageTs: "1785580001.000100", recordedAt: "2026-08-11T00:00:00.000Z" }
  ]);
  const anchor = await repo.findMatterThreadAnchor(1);
  assert.equal(anchor?.rootMessageTs, "1785580001.000100");
});

test("アンカー: channel / ts 欠落・未送信の行は候補から除外する", async () => {
  const repo = anchorRepo([
    { slackChannelId: null },
    { slackMessageTs: null },
    { outcome: "blocked" },
    { slackMessageTs: "not-a-ts" }
  ]);
  assert.equal(await repo.findMatterThreadAnchor(1), null);
});

test("アンカー: 送信履歴が無い案件は null", async () => {
  assert.equal(await anchorRepo([]).findMatterThreadAnchor(1), null);
});

test("アンカー: 案件をまたいで混ざらない", async () => {
  const repo = anchorRepo([
    { matterId: 1, slackMessageTs: "1785580001.000100" },
    { matterId: 2, slackMessageTs: "1785580002.000100" }
  ]);
  const anchor = await repo.findMatterThreadAnchor(2);
  assert.equal(anchor?.rootMessageTs, "1785580002.000100");
  assert.equal(anchor?.legacyRootCount, 0);
  assert.equal((await repo.listMatterDeliveries(2)).length, 1);
});

test("既存の重複判定 list() の挙動を壊さない", async () => {
  const repo = new MemorySlackNotificationHistoryRepository();
  await repo.append({
    matterId: 1, issueKey: "LEGAL-1", fingerprint: "abc", requesterStatus: "intake",
    outcome: "sent", headline: "受付", slackChannelId: "D0123456789",
    slackMessageTs: "1785580000.000100", recordedBy: "test"
  } as never);
  // 同一 issueKey + fingerprint の再送は重複として記録されない。
  await repo.append({
    matterId: 1, issueKey: "LEGAL-1", fingerprint: "abc", requesterStatus: "intake",
    outcome: "sent", headline: "受付", slackChannelId: "D0123456789",
    slackMessageTs: "1785589999.000900", recordedBy: "test"
  } as never);
  const listed = await repo.list(["LEGAL-1"]);
  assert.equal(listed.length, 1);
  assert.equal((await repo.findMatterThreadAnchor(1))?.rootMessageTs, "1785580000.000100");
});
