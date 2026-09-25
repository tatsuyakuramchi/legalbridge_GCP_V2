import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { MemoryBacklogReader, type BacklogIssue } from "../integrations/adapters.js";
import { BacklogPullJob, CURSOR_KEY, OVERLAP_MS, PAGE_SIZE } from "./backlog-pull.js";

const NOW = new Date("2026-09-25T02:00:00Z");
const issue = (n: number, updated: string, over: Partial<BacklogIssue> = {}): BacklogIssue => ({
  id: 9000 + n, issueKey: `LEGAL-${9000 + n}`, summary: `【文書作成】株式会社甲_発注書 ${n}`,
  issueType: { name: "契約審査" }, status: { name: "未対応" }, updated, ...over
});

interface State {
  cursor?: string | null;
  intake?: Record<string, any>;          // issueKey → 既存の受付箱の行
  byRequestNo?: Record<string, any>;     // request_no → 既存の行（キー未控え）
  linked?: string[];                     // 案件に繋がっている課題キー
  failOn?: string;                       // この課題キーで INSERT を失敗させる
}

const db = (state: State = {}) => new FakeDatabase((t, p) => {
  if (t.includes("FROM settings WHERE key")) return state.cursor ? [{ since: state.cursor }] : [];
  if (t.includes("WHERE backlog_issue_id = $1 OR backlog_issue_key = $2")) {
    const row = state.intake?.[String(p[1])];
    return row ? [row] : [];
  }
  if (t.includes("WHERE request_no = $1 AND backlog_issue_key IS NULL")) {
    const row = state.byRequestNo?.[String(p[0])];
    return row ? [row] : [];
  }
  if (t.includes("FROM matter_links WHERE target_type = 'backlog_issue'")) {
    return state.linked?.includes(String(p[0])) ? [{ x: 1 }] : [];
  }
  if (t.includes("SELECT 1 FROM document_sequences")) return [{ x: 1 }];
  if (t.includes("UPDATE document_sequences")) return [{ current_value: 7 }];
  if (t.includes("FROM intake_requests WHERE request_no = $1")) return [];
  if (t.includes("INSERT INTO intake_requests")) {
    if (state.failOn && p[8] === state.failOn) throw new Error("boom");
    return [{ id: 1 }];
  }
  return undefined;
});

const job = (d: FakeDatabase, reader: MemoryBacklogReader | null,
             settings = { mode: "dry_run" as const, readOnly: false }) =>
  new BacklogPullJob(d, reader, () => settings, () => NOW);

test("連携が無効・参照専用・接続情報なしなら動かず、理由を返す", async () => {
  const d = db();
  const reader = new MemoryBacklogReader([]);
  assert.match((await new BacklogPullJob(d, reader, () => ({ mode: "off", readOnly: false })).run()).reason!, /BACKLOG_MODE=off/);
  assert.match((await new BacklogPullJob(d, reader, () => ({ mode: "live", readOnly: true })).run()).reason!, /読み取り専用/);
  assert.match((await job(d, null).run()).reason!, /接続情報/);
  assert.equal(reader.calls.length, 0);
});

test("初回は24時間前から、更新順に読む。新しい課題は受付箱に入る", async () => {
  const d = db();
  const reader = new MemoryBacklogReader([issue(1, "2026-09-25T01:00:00Z")]);
  const r = await job(d, reader).run();
  assert.equal(r.ran, true);
  assert.equal(r.since, new Date(NOW.getTime() - 24 * 3600 * 1000).toISOString());
  assert.deepEqual(reader.calls[0], {
    count: PAGE_SIZE, offset: 0, sort: "updated", order: "asc", updatedSince: "2026-09-23"
  }, "開始は東京の 09/24 11:00。updatedSince は日付単位なので、さらに1日前の日付で取る");
  assert.deepEqual(r.counts, { created: 1 });
  const ins = d.find("INSERT INTO intake_requests")!;
  assert.equal(ins.params[0], "REQ-2026-00007");
  assert.equal(ins.params[1], "outsourcing", "件名の「発注書」から推す");
  assert.equal(ins.params[8], "LEGAL-9001");
  assert.ok(d.find("INSERT INTO settings"), "栞を進める");
  assert.equal(d.find("INSERT INTO settings")!.params[0], CURSOR_KEY);
});

test("栞の5分前から読み直し、範囲より古いものは数えない", async () => {
  const d = db({ cursor: "2026-09-25T01:00:00.000Z" });
  const reader = new MemoryBacklogReader([
    issue(1, "2026-09-25T00:50:00Z"),   // 範囲外
    issue(2, "2026-09-25T00:56:00Z")    // 栞−5分 以降
  ]);
  const r = await job(d, reader).run();
  assert.equal(r.since, new Date(Date.parse("2026-09-25T01:00:00Z") - OVERLAP_MS).toISOString());
  assert.equal(r.fetched, 1);
});

test("案件に繋がっている課題は受付箱に入れない", async () => {
  const d = db({ linked: ["LEGAL-9001"] });
  const r = await job(d, new MemoryBacklogReader([issue(1, "2026-09-25T01:00:00Z")])).run();
  assert.deepEqual(r.counts, { linked_to_matter: 1 });
  assert.equal(d.find("INSERT INTO intake_requests"), undefined);
});

test("Slack 受付で立てた課題は、キーを控える前に読まれても同じ依頼に繋ぐ", async () => {
  const d = db({ byRequestNo: { "REQ-2026-00003": { id: 3, state: "new", backlog_updated_at: null } } });
  const r = await job(d, new MemoryBacklogReader([
    issue(1, "2026-09-25T01:00:00Z", { summary: "[REQ-2026-00003] 追加発注" })
  ])).run();
  assert.deepEqual(r.counts, { attached: 1 });
  assert.equal(d.find("INSERT INTO intake_requests"), undefined, "二重に入れない");
  const upd = d.find("UPDATE intake_requests")!;
  assert.deepEqual([upd.params[0], upd.params[1], upd.params[6]], [3, "LEGAL-9001", false]);
});

test("受付済みの課題が Backlog で更新されたら「更新あり」にする。案件は動かさない", async () => {
  const d = db({ intake: { "LEGAL-9001": {
    id: 5, state: "accepted", backlog_updated_at: "2026-09-25T00:30:00Z", backlog_issue_key: "LEGAL-9001" } } });
  const r = await job(d, new MemoryBacklogReader([
    issue(1, "2026-09-25T01:00:00Z", { status: { name: "完了" } })
  ])).run();
  assert.deepEqual(r.counts, { updated: 1 });
  const upd = d.find("UPDATE intake_requests")!;
  assert.equal(upd.params[3], "完了");
  assert.equal(upd.params[6], true, "has_unseen_update");
  assert.ok(d.texts.some((t) => t.includes("INSERT INTO audit_events")));
  assert.ok(!d.texts.some((t) => t.includes("UPDATE matters")), "案件は動かさない");
});

test("同じ更新時刻なら何もしない", async () => {
  const d = db({ intake: { "LEGAL-9001": {
    id: 5, state: "accepted", backlog_updated_at: "2026-09-25T01:00:00Z" } } });
  const r = await job(d, new MemoryBacklogReader([issue(1, "2026-09-25T01:00:00Z")])).run();
  assert.deepEqual(r.counts, { unchanged: 1 });
  assert.equal(d.find("UPDATE intake_requests"), undefined);
});

test("100件ちょうどなら次のページも読む", async () => {
  const d = db();
  const many = Array.from({ length: PAGE_SIZE + 1 }, (_, i) =>
    issue(i, new Date(Date.parse("2026-09-25T01:00:00Z") + i * 1000).toISOString()));
  const reader = new MemoryBacklogReader(many);
  const r = await job(d, reader).run();
  assert.equal(reader.calls.length, 2);
  assert.equal(reader.calls[1].offset, PAGE_SIZE);
  assert.equal(r.fetched, PAGE_SIZE + 1);
});

test("1件の失敗で残りを止めない。栞は失敗より手前までしか進めない", async () => {
  const d = db({ failOn: "LEGAL-9002" });
  const r = await job(d, new MemoryBacklogReader([
    issue(1, "2026-09-25T01:00:00Z"), issue(2, "2026-09-25T01:05:00Z"), issue(3, "2026-09-25T01:10:00Z")
  ])).run();
  assert.equal(r.counts.created, 2);
  assert.equal(r.counts.failed, 1);
  assert.equal(r.failures[0].issueKey, "LEGAL-9002");
  assert.equal(r.cursorAfter, "2026-09-25T01:00:00.000Z");
});

test("読み取りの失敗は例外にする（0件と取り違えて栞を進めない）", async () => {
  const d = db();
  const broken = new MemoryBacklogReader([]);
  broken.listIssues = async () => { throw new Error("Backlog の課題一覧を読めませんでした (429)"); };
  await assert.rejects(job(d, broken).run(), /429/);
  assert.equal(d.find("INSERT INTO settings"), undefined);
});
