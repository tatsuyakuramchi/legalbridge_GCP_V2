import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createMatterSlackRouter, type MatterSlackSettings } from "./matter-slack-routes.js";
import { MemoryMatterRepository, type MatterDetail } from "./repository.js";
import {
  MemoryMatterSlackThreadRepository, MemoryMatterMentionRepository
} from "./matter-slack-thread-repository.js";
import type { MatterSlackChannelAdapter, MatterSlackReply } from "../integrations/slack-matter-channel.js";

const detail: MatterDetail = {
  matter: {
    id: 5, matterCode: "MTR-2026-00005", title: "ライセンス契約", status: "in_progress",
    counterparty: "株式会社甲", primaryIssueKey: "LB-5", lifecycleStage: "drafting",
    ownerName: null, targetDueDate: null, blockedReason: null,
    issueCount: 1, documentCount: 0, openTaskCount: 1,
    nextTaskTitle: null, nextTaskDueAt: null, updatedAt: "2026-08-07T00:00:00.000Z",
    remarks: null, driveFolderUrl: null
  },
  issues: [], tasks: [], documents: []
};

class FakeChannel implements MatterSlackChannelAdapter {
  readonly configured = true;
  posts: Array<{ channel: string; text: string; threadTs?: string }> = [];
  async postMessage(input: { channel: string; text: string; threadTs?: string }) {
    this.posts.push(input);
    return { channel: input.channel, ts: `170000000.${this.posts.length}` };
  }
  async getReplies(): Promise<MatterSlackReply[]> {
    return [{ ts: "170000000.1", user: "U1", text: "root", bot: true }];
  }
}

function appFor(options: {
  role?: "admin" | "legal" | "requester"; enabled?: boolean;
  channel?: MatterSlackChannelAdapter; threads?: MemoryMatterSlackThreadRepository;
  mentions?: MemoryMatterMentionRepository; legalChannelId?: string;
}) {
  const channel = options.channel ?? new FakeChannel();
  const threads = options.threads ?? new MemoryMatterSlackThreadRepository();
  const mentions = options.mentions ?? new MemoryMatterMentionRepository(
    [{ name: "甲野", id: "U01ABCDEFGH" }], [{ id: "U01ABCDEFGH", email: "kono@example.com" }]);
  const settings: MatterSlackSettings = {
    enabled: options.enabled ?? true,
    legalChannelId: options.legalChannelId ?? "C0LEGAL"
  };
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.currentUser = { email: "u@arclight.co.jp", subject: "s", role: options.role ?? "admin", source: "disabled" };
    next();
  });
  app.use("/api/v2", createMatterSlackRouter({
    matters: new MemoryMatterRepository([detail]), threads, mentions, channel, settings
  }));
  return { app, channel, threads };
}

test("メンション候補を返す（enabled は Slack 設定に依存）", async () => {
  const res = await request(appFor({ enabled: true }).app).get("/api/v2/matters/slack/mention-candidates");
  assert.equal(res.status, 200);
  assert.equal(res.body.enabled, true);
  assert.equal(res.body.candidates[0].id, "U01ABCDEFGH");
});

test("依頼者ロールは操作できない", async () => {
  const res = await request(appFor({ role: "requester" }).app).get("/api/v2/matters/slack/mention-candidates");
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "MATTER_SLACK_FORBIDDEN");
});

test("スレッド作成→ルート投稿し、再作成は冪等(created:false)", async () => {
  const { app, channel, threads } = appFor({ enabled: true });
  const first = await request(app).post("/api/v2/matters/5/slack/thread").send({});
  assert.equal(first.status, 201);
  assert.equal(first.body.created, true);
  assert.match(first.body.thread.threadTs, /^\d+\.\d+$/);
  assert.equal((channel as FakeChannel).posts.length, 1);
  assert.match((channel as FakeChannel).posts[0].text, /法務相談スレッド MTR-2026-00005/);
  const second = await request(app).post("/api/v2/matters/5/slack/thread").send({});
  assert.equal(second.status, 200);
  assert.equal(second.body.created, false);
  // 2回目は投稿しない（冪等）。
  assert.equal((channel as FakeChannel).posts.length, 1);
  assert.equal((await threads.findByMatter(5))?.channelId, "C0LEGAL");
});

test("メンション付きメッセージをスレッドへ投稿する", async () => {
  const threads = new MemoryMatterSlackThreadRepository();
  const { app, channel } = appFor({ enabled: true, threads });
  await request(app).post("/api/v2/matters/5/slack/thread").send({});
  const res = await request(app).post("/api/v2/matters/5/slack/messages")
    .send({ text: "確認をお願いします。", mentions: ["U01ABCDEFGH", "bad-id"] });
  assert.equal(res.status, 201);
  assert.match(res.body.text, /確認をお願いします。 <@U01ABCDEFGH>$/);
  const reply = (channel as FakeChannel).posts.at(-1)!;
  assert.equal(reply.threadTs !== undefined, true); // スレッド返信
});

test("スレッド未作成でのメッセージ投稿は409", async () => {
  const res = await request(appFor({ enabled: true }).app)
    .post("/api/v2/matters/5/slack/messages").send({ text: "x" });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "MATTER_SLACK_THREAD_MISSING");
});

test("Slack無効時、スレッド作成は409", async () => {
  const res = await request(appFor({ enabled: false }).app)
    .post("/api/v2/matters/5/slack/thread").send({});
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "MATTER_SLACK_DISABLED");
});

test("チャンネル未設定なら enabled=false（候補は返る）", async () => {
  const res = await request(appFor({ enabled: true, legalChannelId: "" }).app)
    .get("/api/v2/matters/slack/mention-candidates");
  assert.equal(res.status, 200);
  assert.equal(res.body.enabled, false);
});
