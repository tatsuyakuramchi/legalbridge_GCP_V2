import test from "node:test";
import assert from "node:assert/strict";
import { GmailMailSource, MemoryMailSource, extractParts, toInboundMail } from "./mail-source.js";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

const message = (over: Record<string, unknown> = {}) => ({
  id: "18f0", threadId: "th1", internalDate: "1756684800000",
  payload: {
    headers: [
      { name: "From", value: "田中 <tanaka@example.co.jp>" },
      { name: "To", value: "legal@arch.co.jp, keiri@arch.co.jp" },
      { name: "Subject", value: "契約書の件" },
      { name: "Message-ID", value: "<abc@example.co.jp>" }
    ],
    mimeType: "multipart/mixed",
    parts: [
      { mimeType: "text/plain", body: { data: b64("本文です。") } },
      { mimeType: "application/pdf", filename: "契約書.pdf", body: { size: 20480 } }
    ]
  },
  ...over
});

test("本文と添付を取り出す", () => {
  const { body, attachments } = extractParts(message().payload);
  assert.equal(body, "本文です。");
  assert.deepEqual(attachments, [
    { filename: "契約書.pdf", mimeType: "application/pdf", size: 20480 }
  ]);
});

test("本文が HTML しかなければタグを落として読む", () => {
  const { body } = extractParts({
    mimeType: "multipart/alternative",
    parts: [{ mimeType: "text/html", body: { data: b64("<p>お世話に<br>なります</p>") } }]
  });
  assert.equal(body, "お世話に\nなります");
});

test("入れ子の multipart でも本文に届く", () => {
  const { body, attachments } = extractParts({
    mimeType: "multipart/mixed",
    parts: [
      { mimeType: "multipart/alternative",
        parts: [{ mimeType: "text/plain", body: { data: b64("入れ子の本文") } }] },
      { mimeType: "image/png", filename: "図.png", body: { size: 10 } }
    ]
  });
  assert.equal(body, "入れ子の本文");
  assert.equal(attachments.length, 1);
});

test("Gmail のメッセージを V3 の形にする", () => {
  const m = toInboundMail(message());
  assert.equal(m.messageId, "18f0");
  assert.equal(m.threadId, "th1");
  assert.equal(m.subject, "契約書の件");
  assert.deepEqual(m.to, ["legal@arch.co.jp", "keiri@arch.co.jp"]);
  assert.equal(m.rfcMessageId, "<abc@example.co.jp>");
  assert.equal(m.receivedAt, new Date(1756684800000).toISOString());
});

test("ラベルで絞り、栞から後だけを取り、古い順で返す", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(String(url));
    if (String(url).includes("/messages?")) {
      return { ok: true, json: async () => ({ messages: [{ id: "b" }, { id: "a" }] }) };
    }
    const id = String(url).includes("/b?") ? "b" : "a";
    return {
      ok: true,
      json: async () => message({
        id, threadId: id,
        internalDate: id === "a" ? "1756000000000" : "1756900000000"
      })
    };
  }) as unknown as typeof fetch;

  const source = new GmailMailSource(async () => "tok", "法務受付", fetchImpl);
  const mails = await source.list({ since: new Date("2026-09-01T00:00:00Z"), limit: 10 });

  assert.ok(calls[0].includes("label%3A%E6%B3%95%E5%8B%99%E5%8F%97%E4%BB%98"), calls[0]);
  assert.ok(/after%3A17\d+/.test(calls[0]), calls[0]);
  // Gmail は新しい順で返す。取り込みは古い順でないと、途中で止まったとき
  // 古いものが取り残される。
  assert.deepEqual(mails.map((m) => m.messageId), ["a", "b"]);
});

test("ラベルが無ければ未設定として扱う", () => {
  assert.equal(new GmailMailSource(async () => "t", "").configured, false);
  assert.equal(new GmailMailSource(async () => "t", "法務").configured, true);
});

test("一覧の失敗は握りつぶさない", async () => {
  const fetchImpl = (async () => ({ ok: false, status: 403, text: async () => "denied" })) as unknown as typeof fetch;
  const source = new GmailMailSource(async () => "t", "法務", fetchImpl);
  await assert.rejects(() => source.list({}), /403/);
});

test("Memory 版は栞より前を返さない", async () => {
  const source = new MemoryMailSource([
    { ...toInboundMail(message({ id: "old", internalDate: "1756000000000" })) },
    { ...toInboundMail(message({ id: "new", internalDate: "1756900000000" })) }
  ]);
  const mails = await source.list({ since: new Date(1756500000000) });
  assert.deepEqual(mails.map((m) => m.messageId), ["new"]);
});
