import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createMatterSlackHistoryRouter } from "./matter-slack-history-routes.js";
import { MemorySlackNotificationHistoryRepository } from "../integrations/slack-history-repository.js";
import {
  DisabledSlackConversationReader, SlackConversationReadError,
  type SlackConversationReader, type SlackThread
} from "../integrations/slack-conversation-reader.js";

function historyWith(rows: Array<Partial<{
  matterId: number; issueKey: string; requesterStatus: string;
  outcome: string; channelId: string; ts: string; recordedAt: string; headline: string;
}>>) {
  const repo = new MemorySlackNotificationHistoryRepository();
  rows.forEach((row, index) => repo.seedRow({
    matterId: row.matterId ?? 1,
    issueKey: row.issueKey ?? `LEGAL-${index + 1}`,
    fingerprint: `f${index}`,
    requesterStatus: (row.requesterStatus ?? "in_review") as never,
    outcome: (row.outcome ?? "sent") as never,
    headline: row.headline ?? `通知${index + 1}`,
    slackChannelId: row.channelId ?? "D0123456789",
    slackMessageTs: row.ts ?? `178558000${index}.000100`,
    recordedAt: row.recordedAt ?? `2026-08-1${index + 1}T00:00:00.000Z`,
    recordedBy: "test"
  }));
  return repo;
}

const okReader = (thread: SlackThread): SlackConversationReader => ({
  configured: true,
  getThread: async () => thread
});

function app(deps: Parameters<typeof createMatterSlackHistoryRouter>[0], role: "admin" | "legal" | "requester" = "legal") {
  const a = express();
  a.use((_req, res, next) => {
    res.locals.currentUser = { email: "u@example.com", role, subject: "u", source: "iap" };
    next();
  });
  a.use("/api/v2", createMatterSlackHistoryRouter(deps));
  return a;
}

test("admin/legal は参照可・requester は403", async () => {
  const deps = { history: historyWith([]), reader: new DisabledSlackConversationReader() };
  for (const role of ["admin", "legal"] as const) {
    assert.equal((await request(app(deps, role)).get("/api/v2/matters/1/slack")).status, 200);
  }
  const denied = await request(app(deps, "requester")).get("/api/v2/matters/1/slack");
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, "MATTER_SLACK_HISTORY_FORBIDDEN");
});

test("アンカーが無ければ linked:false（Slack は呼ばない）", async () => {
  let called = false;
  const reader: SlackConversationReader = {
    configured: true, getThread: async () => { called = true; return { messages: [] }; }
  };
  const res = await request(app({ history: historyWith([]), reader })).get("/api/v2/matters/1/slack");
  assert.equal(res.status, 200);
  assert.equal(res.body.linked, false);
  assert.equal(called, false);
});

test("intake の受付通知を canonical root にし、他は legacyRootCount に数える", async () => {
  const history = historyWith([
    { requesterStatus: "in_review", ts: "1785580001.000100", recordedAt: "2026-08-11T00:00:00.000Z" },
    { requesterStatus: "intake", ts: "1785580002.000100", recordedAt: "2026-08-12T00:00:00.000Z" }
  ]);
  const res = await request(app({ history, reader: okReader({ messages: [] }) }))
    .get("/api/v2/matters/1/slack");
  assert.equal(res.body.thread.rootMessageTs, "1785580002.000100");
  assert.equal(res.body.thread.legacyRootCount, 1);
});

test("読取OFFなら configured:false でアンカーと送信履歴だけ返す", async () => {
  const history = historyWith([{ headline: "受付しました" }]);
  const res = await request(app({ history, reader: new DisabledSlackConversationReader() }))
    .get("/api/v2/matters/1/slack");
  assert.equal(res.body.configured, false);
  assert.equal(res.body.linked, true);
  assert.deepEqual(res.body.messages, []);
  assert.equal(res.body.deliveries[0].headline, "受付しました");
});

test("会話を取得して発言者名・メンションを担当者マスタで解決する", async () => {
  const history = historyWith([{ requesterStatus: "intake", ts: "1785580000.000100" }]);
  const reader = okReader({ messages: [
    { ts: "1785580000.000100", authorType: "legalbridge", authorId: "B1", text: "受付", isRoot: true },
    { ts: "1785580500.000200", authorType: "user", authorId: "U0ABC123",
      text: "<@U0ABC123> 確認しました", isRoot: false }
  ] });
  const mentions = { listCandidates: async () => [{ id: "U0ABC123", name: "田中 太郎" }],
    emailsForSlackIds: async () => [], slackIdsForStaffIds: async () => [] };
  const res = await request(app({ history, reader, mentions })).get("/api/v2/matters/1/slack");
  assert.equal(res.body.available, true);
  assert.equal(res.body.messages[0].authorName, "LegalBridge");
  assert.equal(res.body.messages[1].authorName, "田中 太郎");
  assert.equal(res.body.messages[1].text, "@田中 太郎 確認しました");
});

test("Slack 失敗は 200＋available:false（案件画面を落とさない）", async () => {
  const history = historyWith([{ requesterStatus: "intake" }]);
  const reader: SlackConversationReader = {
    configured: true,
    getThread: async () => { throw new SlackConversationReadError("rate_limited", "429"); }
  };
  const res = await request(app({ history, reader })).get("/api/v2/matters/1/slack");
  assert.equal(res.status, 200);
  assert.equal(res.body.available, false);
  assert.equal(res.body.reason, "rate_limited");
  assert.ok(res.body.thread);
});

test("案件をまたいで履歴が混ざらない", async () => {
  const history = historyWith([
    { matterId: 1, ts: "1785580001.000100" },
    { matterId: 2, ts: "1785580002.000100" }
  ]);
  const res = await request(app({ history, reader: okReader({ messages: [] }) }))
    .get("/api/v2/matters/2/slack");
  assert.equal(res.body.thread.rootMessageTs, "1785580002.000100");
  assert.equal(res.body.thread.legacyRootCount, 0);
  assert.equal(res.body.deliveries.length, 1);
});

test("同一アンカーの連続取得はキャッシュし、refresh=1 で再取得する", async () => {
  let calls = 0;
  const history = historyWith([{ requesterStatus: "intake" }]);
  const reader: SlackConversationReader = {
    configured: true,
    getThread: async () => { calls += 1; return { messages: [] }; }
  };
  const a = app({ history, reader });
  await request(a).get("/api/v2/matters/1/slack");
  await request(a).get("/api/v2/matters/1/slack");
  assert.equal(calls, 1);
  await request(a).get("/api/v2/matters/1/slack?refresh=1");
  assert.equal(calls, 2);
});

test("履歴リポジトリ未設定でも 200 で縮退する", async () => {
  const res = await request(app({ reader: new DisabledSlackConversationReader() }))
    .get("/api/v2/matters/1/slack");
  assert.equal(res.status, 200);
  assert.equal(res.body.linked, false);
});
