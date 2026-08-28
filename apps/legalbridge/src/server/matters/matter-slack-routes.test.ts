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
import { MemoryDrivePermissionGranter } from "../documents/drive-permission.js";

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
  granter?: MemoryDrivePermissionGranter; withDocument?: boolean;
  documents?: MatterDetail["documents"];
}) {
  const channel = options.channel ?? new FakeChannel();
  const threads = options.threads ?? new MemoryMatterSlackThreadRepository();
  const mentions = options.mentions ?? new MemoryMatterMentionRepository(
    [{ name: "甲野", id: "U01ABCDEFGH" }], [{ id: "U01ABCDEFGH", email: "kono@example.com" }]);
  const settings: MatterSlackSettings = {
    enabled: options.enabled ?? true,
    legalChannelId: options.legalChannelId ?? "C0LEGAL"
  };
  const matterDetail: MatterDetail = options.documents
    ? { ...detail, documents: options.documents }
    : options.withDocument
      ? { ...detail, documents: [{ id: 9, documentNumber: "DOC-1", templateType: "license", issueKey: "LB-5", createdAt: "2026-08-07T00:00:00.000Z", driveLink: "https://drive.google.com/file/d/1Abc_def-GHI23456789/view" }] }
      : detail;
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.currentUser = { email: "u@arclight.co.jp", subject: "s", role: options.role ?? "admin", source: "disabled" };
    next();
  });
  app.use("/api/v2", createMatterSlackRouter({
    matters: new MemoryMatterRepository([matterDetail]), threads, mentions, channel, settings,
    granter: options.granter
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

test("テンプレ2は閲覧リンク（最新文書）を載せ、メンション先へDrive権限を付与する", async () => {
  const threads = new MemoryMatterSlackThreadRepository();
  const granter = new MemoryDrivePermissionGranter();
  const { app } = appFor({ enabled: true, threads, granter, withDocument: true });
  await request(app).post("/api/v2/matters/5/slack/thread").send({});
  const res = await request(app).post("/api/v2/matters/5/slack/template")
    .send({ template: 2, mentions: ["U01ABCDEFGH"] });
  assert.equal(res.status, 201);
  assert.match(res.body.text, /^文書作成が完了しました。 <@U01ABCDEFGH>/);
  assert.match(res.body.text, /閲覧リンク: https:\/\/drive\.google\.com/);
  assert.equal(res.body.grant.skipped, false);
  assert.deepEqual(res.body.grant.granted, ["kono@example.com"]);
  assert.deepEqual(granter.grants, [{ fileId: "1Abc_def-GHI23456789", email: "kono@example.com" }]);
});

const TWO_DOCUMENTS: MatterDetail["documents"] = [
  { id: 9, documentNumber: "DOC-1", templateType: "license", issueKey: "LB-5",
    createdAt: "2026-08-07T00:00:00.000Z", driveLink: "https://drive.google.com/file/d/1Abc_def-GHI23456789/view" },
  { id: 10, documentNumber: "DOC-2", templateType: "inspection_certificate", issueKey: "LB-5",
    createdAt: "2026-08-08T00:00:00.000Z", driveLink: "https://drive.google.com/file/d/2Xyz_uvw-QRS98765432/view" }
];

test("テンプレ2は documentIds で複数リンクを箇条書きし、全ファイルへDrive権限を付与する", async () => {
  const threads = new MemoryMatterSlackThreadRepository();
  const granter = new MemoryDrivePermissionGranter();
  const { app } = appFor({ enabled: true, threads, granter, documents: TWO_DOCUMENTS });
  await request(app).post("/api/v2/matters/5/slack/thread").send({});
  const res = await request(app).post("/api/v2/matters/5/slack/template")
    .send({ template: 2, mentions: ["U01ABCDEFGH"], documentIds: [9, 10] });
  assert.equal(res.status, 201);
  assert.match(res.body.text, /閲覧リンク:\n・DOC-1: https:\/\/drive\.google\.com.*\n・DOC-2: https:\/\/drive\.google\.com/);
  assert.deepEqual(res.body.grant.granted, ["kono@example.com"]);
  assert.deepEqual(granter.grants.map((g) => g.fileId),
    ["1Abc_def-GHI23456789", "2Xyz_uvw-QRS98765432"]);
});

test("documentIds: [] は「リンクなし」の明示＝最新文書へフォールバックしない", async () => {
  const threads = new MemoryMatterSlackThreadRepository();
  const granter = new MemoryDrivePermissionGranter();
  const { app } = appFor({ enabled: true, threads, granter, documents: TWO_DOCUMENTS });
  await request(app).post("/api/v2/matters/5/slack/thread").send({});
  const res = await request(app).post("/api/v2/matters/5/slack/template")
    .send({ template: 2, mentions: ["U01ABCDEFGH"], documentIds: [] });
  assert.equal(res.status, 201);
  assert.doesNotMatch(res.body.text, /閲覧リンク/);
  assert.equal(res.body.grant.skipped, true);
  assert.equal(granter.grants.length, 0);
});

test("テンプレ1(CloudSign送信済)はDrive付与せず相手方チェーンを投稿", async () => {
  const threads = new MemoryMatterSlackThreadRepository();
  const granter = new MemoryDrivePermissionGranter();
  const { app } = appFor({ enabled: true, threads, granter });
  await request(app).post("/api/v2/matters/5/slack/thread").send({});
  const res = await request(app).post("/api/v2/matters/5/slack/template")
    .send({ template: 1, mentions: ["U01ABCDEFGH"], cc: ["U02ABCDEFGH"] });
  assert.equal(res.status, 201);
  assert.match(res.body.text, /クラウドサインで送信しました。 <@U01ABCDEFGH> → 相手方  CC: <@U02ABCDEFGH>/);
  assert.equal(res.body.grant.skipped, true);
  assert.equal(granter.grants.length, 0);
});
