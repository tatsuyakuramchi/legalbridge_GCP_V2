import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveMatterUpdateNotification, deriveTaskNotification, LiveMatterSlackNotifier
} from "./matter-slack-notifier.js";
import {
  MemoryMatterSlackThreadRepository, MemoryMatterMentionRepository
} from "./matter-slack-thread-repository.js";
import type { MatterSlackChannelAdapter, MatterSlackReply } from "../integrations/slack-matter-channel.js";

test("案件更新: 変更項目をまとめ、担当変更時は新担当をメンション対象にする", () => {
  const note = deriveMatterUpdateNotification({ status: "closed", ownerStaffId: 7 } as any);
  assert.match(note!.text, /ステータス: \*closed\*/);
  assert.match(note!.text, /担当変更/);
  assert.deepEqual(note!.mentionStaffIds, [7]);
});

test("案件更新: 変更なしなら null（no-op）", () => {
  assert.equal(deriveMatterUpdateNotification({ title: "新名称" } as any), null);
});

test("案件更新: ブロック理由設定は warning 文言", () => {
  const note = deriveMatterUpdateNotification({ blockedReason: "先方確認待ち" } as any);
  assert.match(note!.text, /:warning: ブロック: 先方確認待ち/);
  assert.deepEqual(note!.mentionStaffIds, []);
});

test("タスク作成: 担当付きは割当文言＋メンション", () => {
  const note = deriveTaskNotification({ title: "契約書レビュー", assigneeStaffId: 3 } as any, { isCreate: true });
  assert.match(note!.text, /タスク「契約書レビュー」を割り当てました。/);
  assert.deepEqual(note!.mentionStaffIds, [3]);
});

test("タスク更新: 状態のみは担当メンションなし", () => {
  const note = deriveTaskNotification({ status: "done" } as any, { isCreate: false });
  assert.match(note!.text, /状態: done/);
  assert.deepEqual(note!.mentionStaffIds, []);
});

class FakeChannel implements MatterSlackChannelAdapter {
  readonly configured = true;
  posts: Array<{ channel: string; text: string; threadTs?: string }> = [];
  async postMessage(input: { channel: string; text: string; threadTs?: string }) {
    this.posts.push(input); return { channel: input.channel, ts: "170.1" };
  }
  async getReplies(): Promise<MatterSlackReply[]> { return []; }
}

test("Live通知: スレッド有り＋担当変更で <@slackId> を付けてスレッド投稿する", async () => {
  const threads = new MemoryMatterSlackThreadRepository([
    { matterId: 5, channelId: "C0LEGAL", threadTs: "170.0", rootText: "root", createdBy: "x", createdAt: "2026-08-07T00:00:00.000Z" }
  ]);
  const mentions = new MemoryMatterMentionRepository([], [], [{ staffId: 7, slackId: "U01ABCDEFGH" }]);
  const channel = new FakeChannel();
  const notifier = new LiveMatterSlackNotifier({ enabled: true, threads, mentions, channel });
  await notifier.notifyMatterUpdate(5, { status: "closed", ownerStaffId: 7 } as any);
  assert.equal(channel.posts.length, 1);
  assert.match(channel.posts[0].text, /案件を更新しました（ステータス: \*closed\* \/ 担当変更） <@U01ABCDEFGH>$/);
  assert.equal(channel.posts[0].threadTs, "170.0");
});

test("Live通知: スレッド未作成なら投稿しない（no-op）", async () => {
  const channel = new FakeChannel();
  const notifier = new LiveMatterSlackNotifier({
    enabled: true, threads: new MemoryMatterSlackThreadRepository(),
    mentions: new MemoryMatterMentionRepository(), channel
  });
  await notifier.notifyTask(5, { title: "x", assigneeStaffId: 3 } as any, { isCreate: true });
  assert.equal(channel.posts.length, 0);
});

test("Live通知: 無効時は投稿しない", async () => {
  const threads = new MemoryMatterSlackThreadRepository([
    { matterId: 5, channelId: "C0LEGAL", threadTs: "170.0", rootText: "r", createdBy: "x", createdAt: "2026-08-07T00:00:00.000Z" }
  ]);
  const channel = new FakeChannel();
  const notifier = new LiveMatterSlackNotifier({
    enabled: false, threads, mentions: new MemoryMatterMentionRepository(), channel
  });
  await notifier.notifyMatterUpdate(5, { status: "closed" } as any);
  assert.equal(channel.posts.length, 0);
});
