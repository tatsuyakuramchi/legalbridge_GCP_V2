import assert from "node:assert/strict";
import test from "node:test";
import { runInspectionDigest, composeInspectionDigest } from "./inspection-digest-runner.js";
import { MemoryPendingInspectionRepository } from "../inspections/repository.js";
import type { PendingInspectionRow } from "../inspections/repository.js";

function row(over: Partial<PendingInspectionRow> & { id: number }): PendingInspectionRow {
  return {
    documentNumber: `PO-${over.id}`, issueKey: `LB-${over.id}`, matterId: over.id,
    matterCode: `M-${over.id}`, matterTitle: "案件", createdAt: "2026-08-01T00:00:00Z", hasInspection: false, ...over
  };
}

test("compose: 件数・文書番号・案件・課題を含み、上限を超えたら省略", () => {
  const rows = Array.from({ length: 23 }, (_v, i) => row({ id: i + 1 }));
  const text = composeInspectionDigest(rows);
  assert.match(text, /検収待ちの発注書（23件）/);
  assert.match(text, /PO-1｜M-1 案件（課題 LB-1）/);
  assert.match(text, /…他 3 件/); // 20行表示＋残り3
});

test("dry-run（post 未指定）: 件数のみ・送信しない", async () => {
  const repo = new MemoryPendingInspectionRepository([row({ id: 1 }), row({ id: 2 })]);
  const summary = await runInspectionDigest({ repo });
  assert.equal(summary.dryRun, true);
  assert.equal(summary.pending, 2);
  assert.equal(summary.sent, false);
});

test("live: 件数>0 なら投稿し sent=true", async () => {
  const repo = new MemoryPendingInspectionRepository([row({ id: 1 })]);
  let posted = "";
  const summary = await runInspectionDigest({ repo, post: async (t) => { posted = t; return true; } });
  assert.equal(summary.dryRun, false);
  assert.equal(summary.pending, 1);
  assert.equal(summary.sent, true);
  assert.match(posted, /検収待ちの発注書（1件）/);
});

test("live: 0件なら投稿しない", async () => {
  const repo = new MemoryPendingInspectionRepository([]);
  let called = false;
  const summary = await runInspectionDigest({ repo, post: async () => { called = true; return true; } });
  assert.equal(summary.pending, 0);
  assert.equal(summary.sent, false);
  assert.equal(called, false);
});

test("live: 投稿失敗は sent=false", async () => {
  const repo = new MemoryPendingInspectionRepository([row({ id: 1 })]);
  const summary = await runInspectionDigest({ repo, post: async () => false });
  assert.equal(summary.sent, false);
});
