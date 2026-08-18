import assert from "node:assert/strict";
import test from "node:test";
import { SlackChannelDirectory } from "./slack-channel-directory.js";
import { SlackWebApiError, type SlackWebApiClient, type SlackWebApiMethod } from "./slack-web-api-adapter.js";

class StubClient implements SlackWebApiClient {
  calls: Array<Record<string, unknown>> = [];
  constructor(private readonly pages: unknown[]) {}
  async post(method: SlackWebApiMethod, body: Record<string, unknown>) {
    assert.equal(method, "conversations.list");
    this.calls.push(body);
    const page = this.pages[this.calls.length - 1];
    if (page instanceof Error) throw page;
    return page;
  }
}

test("公開・非公開の両方を要求し、名前順に返す", async () => {
  const client = new StubClient([{
    channels: [
      { id: "C0ZZZZZZZZ1", name: "zeta", is_private: false, is_member: true },
      { id: "C0AAAAAAAA1", name: "alpha", is_private: true, is_member: false }
    ]
  }]);
  const listing = await new SlackChannelDirectory(client).list();
  assert.equal(listing.available, true);
  assert.deepEqual(listing.channels.map((c) => c.name), ["alpha", "zeta"]);
  assert.deepEqual(listing.channels[0], { id: "C0AAAAAAAA1", name: "alpha", isPrivate: true, isMember: false });
  assert.equal(client.calls[0].types, "public_channel,private_channel");
  assert.equal(client.calls[0].exclude_archived, true);
});

test("next_cursor を辿って全ページ集める", async () => {
  const client = new StubClient([
    { channels: [{ id: "C0AAAAAAAA1", name: "a" }], response_metadata: { next_cursor: "page2" } },
    { channels: [{ id: "C0BBBBBBBB1", name: "b" }], response_metadata: { next_cursor: "" } }
  ]);
  const listing = await new SlackChannelDirectory(client).list();
  assert.deepEqual(listing.channels.map((c) => c.name), ["a", "b"]);
  assert.equal(client.calls[0].cursor, undefined);
  assert.equal(client.calls[1].cursor, "page2");
});

// スコープが無いのは「設定できない」ではなく「一覧が出せない」だけ。画面は直接入力へ落とす。
test("missing_scope は available:false と理由を返す（例外にしない）", async () => {
  const client = new StubClient([new SlackWebApiError("nope", "missing_scope")]);
  const listing = await new SlackChannelDirectory(client).list();
  assert.equal(listing.available, false);
  assert.deepEqual(listing.channels, []);
  assert.match(listing.reason ?? "", /channels:read/);
});

test("その他の失敗も available:false（設定画面を落とさない）", async () => {
  const client = new StubClient([new SlackWebApiError("boom", "ratelimited")]);
  const listing = await new SlackChannelDirectory(client).list();
  assert.equal(listing.available, false);
  assert.match(listing.reason ?? "", /ratelimited/);
});

test("id か name が無い行は捨てる", async () => {
  const client = new StubClient([{ channels: [{ id: "C0AAAAAAAA1" }, { name: "no-id" }, null, "x"] }]);
  const listing = await new SlackChannelDirectory(client).list();
  assert.deepEqual(listing.channels, []);
});

test("TTL 内は Slack を再度叩かない", async () => {
  let now = 1_000_000;
  const client = new StubClient([
    { channels: [{ id: "C0AAAAAAAA1", name: "a" }] },
    { channels: [{ id: "C0BBBBBBBB1", name: "b" }] }
  ]);
  const directory = new SlackChannelDirectory(client, 60_000, () => now);
  await directory.list();
  await directory.list();
  assert.equal(client.calls.length, 1);
  now += 60_001;
  const listing = await directory.list();
  assert.equal(client.calls.length, 2);
  assert.deepEqual(listing.channels.map((c) => c.name), ["b"]);
});

test("同時に呼ばれても1回だけ取りに行く", async () => {
  const client = new StubClient([{ channels: [{ id: "C0AAAAAAAA1", name: "a" }] }]);
  const directory = new SlackChannelDirectory(client);
  const [left, right] = await Promise.all([directory.list(), directory.list()]);
  assert.equal(client.calls.length, 1);
  assert.deepEqual(left.channels, right.channels);
});
