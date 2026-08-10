import assert from "node:assert/strict";
import test from "node:test";
import { LiveDailyChecksNotifier } from "./daily-checks-live-notifier.js";
import type { DailyChecksNotification } from "./daily-checks-runner.js";
import type { MatterSlackChannelAdapter } from "../integrations/slack-matter-channel.js";

const notes: DailyChecksNotification[] = [
  { kind: "delivery_7d", refType: "condition_line", refId: 1, text: "納期まで7日｜A（課題 LB-1）" },
  { kind: "contract_renewal", refType: "document", refId: 9, text: "契約更新の通告期限｜DOC-9" }
];

class CaptureChannel implements MatterSlackChannelAdapter {
  readonly configured = true;
  posts: Array<{ channel: string; text: string }> = [];
  async postMessage(input: { channel: string; text: string; threadTs?: string }) {
    this.posts.push({ channel: input.channel, text: input.text });
    return { ts: "123.456", channel: input.channel };
  }
  async getReplies() { return []; }
}
class FailingChannel implements MatterSlackChannelAdapter {
  readonly configured = true;
  async postMessage(): Promise<never> { throw new Error("slack down"); }
  async getReplies() { return []; }
}

test("live: 1通のダイジェストに全件をまとめ、全件 delivered", async () => {
  const channel = new CaptureChannel();
  const notifier = new LiveDailyChecksNotifier(channel, "C0LEGAL");
  const result = await notifier.send(notes);
  assert.equal(result.delivered.length, 2);
  assert.equal(result.failed, 0);
  assert.equal(channel.posts.length, 1);
  assert.equal(channel.posts[0].channel, "C0LEGAL");
  assert.match(channel.posts[0].text, /本日の督促（2件）/);
  assert.match(channel.posts[0].text, /LB-1/);
  assert.match(channel.posts[0].text, /DOC-9/);
});

test("live: 投稿失敗なら全件未達（台帳記録されない＝次回再送）", async () => {
  const notifier = new LiveDailyChecksNotifier(new FailingChannel(), "C0LEGAL");
  const result = await notifier.send(notes);
  assert.equal(result.delivered.length, 0);
  assert.equal(result.failed, 2);
});

test("live: 空入力は投稿しない", async () => {
  const channel = new CaptureChannel();
  const result = await new LiveDailyChecksNotifier(channel, "C0LEGAL").send([]);
  assert.equal(result.delivered.length, 0);
  assert.equal(channel.posts.length, 0);
});
