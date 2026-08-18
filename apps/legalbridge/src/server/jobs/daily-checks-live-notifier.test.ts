import assert from "node:assert/strict";
import test from "node:test";
import { LiveDailyChecksNotifier } from "./daily-checks-live-notifier.js";
import type { DailyChecksNotification } from "./daily-checks-runner.js";
import type { MatterSlackChannelAdapter } from "../integrations/slack-matter-channel.js";
import { resolveNotification } from "../../notification-settings.js";

const notes: DailyChecksNotification[] = [
  { kind: "delivery_7d", refType: "condition_line", refId: 1, text: "納期まで7日｜A（課題 LB-1）" },
  { kind: "contract_renewal", refType: "document", refId: 9, text: "契約更新の通告期限｜DOC-9" }
];

// 設定画面の保存値から解決するのと同じ経路をテストでも通す（既定は「ON・法務相談CH」）。
const settings = (values: Record<string, string> = {}, fallback = "C0LEGAL") =>
  (id: Parameters<typeof resolveNotification>[1]) => resolveNotification(values, id, fallback);

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
  const notifier = new LiveDailyChecksNotifier(channel, settings());
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
  const notifier = new LiveDailyChecksNotifier(new FailingChannel(), settings());
  const result = await notifier.send(notes);
  assert.equal(result.delivered.length, 0);
  assert.equal(result.failed, 2);
});

test("live: 空入力は投稿しない", async () => {
  const channel = new CaptureChannel();
  const result = await new LiveDailyChecksNotifier(channel, settings()).send([]);
  assert.equal(result.delivered.length, 0);
  assert.equal(channel.posts.length, 0);
});

// ── 設定画面で通知ごとに分けられること ───────────────────────────────
test("宛先が別々なら別々のチャンネルへ投稿する", async () => {
  const channel = new CaptureChannel();
  const notifier = new LiveDailyChecksNotifier(channel, settings({
    NOTIFY_DELIVERY_ALERT_CHANNEL: "C0DELIV", NOTIFY_CONTRACT_ALERT_CHANNEL: "C0KEIYAKU"
  }));
  const result = await notifier.send(notes);
  assert.equal(result.delivered.length, 2);
  assert.deepEqual(channel.posts.map((p) => p.channel).sort(), ["C0DELIV", "C0KEIYAKU"]);
  // 混ざらないこと（納期の本文が契約側へ出ない）。
  const delivery = channel.posts.find((p) => p.channel === "C0DELIV")!;
  assert.match(delivery.text, /LB-1/);
  assert.doesNotMatch(delivery.text, /DOC-9/);
});

test("OFF の通知は投稿も delivered もしない（台帳に残さない）", async () => {
  const channel = new CaptureChannel();
  const notifier = new LiveDailyChecksNotifier(channel, settings({ NOTIFY_DELIVERY_ALERT_ENABLED: "false" }));
  const result = await notifier.send(notes);
  assert.equal(channel.posts.length, 1);
  assert.match(channel.posts[0].text, /DOC-9/);
  assert.doesNotMatch(channel.posts[0].text, /LB-1/);
  assert.deepEqual(result.delivered.map((d) => d.kind), ["contract_renewal"]);
  // 送っていないものを failed に数えると、ジョブの結果が毎日「失敗あり」になってしまう。
  assert.equal(result.failed, 0);
});

test("全部 OFF なら Slack を一切叩かない", async () => {
  const channel = new CaptureChannel();
  const result = await new LiveDailyChecksNotifier(channel, settings({
    NOTIFY_DELIVERY_ALERT_ENABLED: "false", NOTIFY_CONTRACT_ALERT_ENABLED: "off"
  })).send(notes);
  assert.equal(channel.posts.length, 0);
  assert.deepEqual(result, { delivered: [], failed: 0 });
});

test("宛先がどこにも無ければ投稿しない（既定チャンネル未設定）", async () => {
  const channel = new CaptureChannel();
  const result = await new LiveDailyChecksNotifier(channel, settings({}, "")).send(notes);
  assert.equal(channel.posts.length, 0);
  assert.equal(result.delivered.length, 0);
});

test("片方の宛先だけ失敗しても、もう片方は delivered のまま", async () => {
  class HalfBrokenChannel implements MatterSlackChannelAdapter {
    readonly configured = true;
    posts: string[] = [];
    async postMessage(input: { channel: string; text: string }) {
      if (input.channel === "C0DELIV") throw new Error("not_in_channel");
      this.posts.push(input.channel);
      return { ts: "1.1", channel: input.channel };
    }
    async getReplies() { return []; }
  }
  const channel = new HalfBrokenChannel();
  const result = await new LiveDailyChecksNotifier(channel, settings({
    NOTIFY_DELIVERY_ALERT_CHANNEL: "C0DELIV", NOTIFY_CONTRACT_ALERT_CHANNEL: "C0KEIYAKU"
  })).send(notes);
  assert.deepEqual(channel.posts, ["C0KEIYAKU"]);
  assert.deepEqual(result.delivered.map((d) => d.kind), ["contract_renewal"]);
  assert.equal(result.failed, 1);
});

test("未知の kind は投稿しない（振り分け先が無いものを黙って既定へ流さない）", async () => {
  const channel = new CaptureChannel();
  const result = await new LiveDailyChecksNotifier(channel, settings()).send([
    { kind: "mystery", refType: "document", refId: 1, text: "?" }
  ]);
  assert.equal(channel.posts.length, 0);
  assert.equal(result.delivered.length, 0);
});
