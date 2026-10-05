import test from "node:test";
import assert from "node:assert/strict";
import { CloudSignAdapter, GmailAdapter, type DispatchRequest } from "./adapters.js";

const pdf = (name: string) =>
  ({ filename: name, mimeType: "application/pdf", data: Buffer.from(name) });

/** 送った内容を控えるだけの fetch。 */
function recorder(replies: Array<Record<string, unknown>> = []) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let n = 0;
  const impl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const body = replies[n++] ?? { id: `id-${n}`, access_token: "t" };
    return { ok: true, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const mimeOf = (calls: Array<{ init: RequestInit }>) =>
  Buffer.from(JSON.parse(String(calls.at(-1)!.init.body)).raw, "base64url").toString("utf8");

test("メール：bcc はヘッダに入れる（本文には書かない）", async () => {
  // 本文（RFC822）に書くと相手に見える。Gmail はヘッダを見て配り、
  // 受信側には渡さない。
  const { calls, impl } = recorder();
  const adapter = new GmailAdapter(async () => "token", "me@arclight.co.jp", impl);
  await adapter.send({ recipient: "to@example.com", cc: ["cc@example.com"],
                       bcc: ["bcc@arclight.co.jp"], subject: "件名", body: "本文" });
  const mime = mimeOf(calls);
  assert.match(mime, /^To: to@example\.com$/m);
  assert.match(mime, /^Cc: cc@example\.com$/m);
  assert.match(mime, /^Bcc: bcc@arclight\.co\.jp$/m);
});

test("メール：添付は何枚でも入る", async () => {
  // 発注書を数枚、発注書と検収書を1通で、という送り方をする。
  const { calls, impl } = recorder();
  const adapter = new GmailAdapter(async () => "token", "me@arclight.co.jp", impl);
  await adapter.send({ recipient: "to@example.com", subject: "件名", body: "本文",
                       attachments: [pdf("PO-1.pdf"), pdf("PO-2.pdf"), pdf("INS-1.pdf")] });
  const mime = mimeOf(calls);
  for (const name of ["PO-1.pdf", "PO-2.pdf", "INS-1.pdf"]) {
    assert.ok(mime.includes(`filename="${name}"`), name);
  }
});

test("メール：1枚だけの書き方も今までどおり使える", async () => {
  const { calls, impl } = recorder();
  const adapter = new GmailAdapter(async () => "token", "me@arclight.co.jp", impl);
  await adapter.send({ recipient: "to@example.com", subject: "件名", body: "本文",
                       attachment: pdf("one.pdf") });
  assert.ok(mimeOf(calls).includes('filename="one.pdf"'));
});

test("CloudSign：1つの封筒に書類を何枚も入れ、署名者は順番を持つ", async () => {
  const { calls, impl } = recorder();
  const adapter = new CloudSignAdapter("client", "https://cs.test", impl);
  const request: DispatchRequest = {
    recipient: "rep@example.com", subject: "署名のお願い", body: "お願いします",
    attachments: [pdf("PO-1.pdf"), pdf("PO-2.pdf")],
    participants: [{ email: "rep@example.com", name: "代表 太郎" },
                   { email: "mgr@example.com", name: "部長 花子" }],
    reportees: [{ email: "cc@arclight.co.jp", name: "法務" }]
  };
  const receipt = await adapter.send(request);
  const urls = calls.map((c) => c.url);
  // トークン → 書類を作る → ファイル2枚 → 参加者2人 → 確認者1人。送信はしない（下書き）
  assert.equal(urls.filter((u) => u.endsWith("/files")).length, 2);
  assert.equal(receipt.draft, true, "既定は下書きで止める");
  assert.ok(!calls.some((c) => /\/documents\/[^/]+$/.test(c.url) && c.init.method === "POST"),
    "書類そのものへの POST（送信）は打たない");
  assert.equal(urls.filter((u) => u.endsWith("/participants")).length, 2);
  assert.equal(urls.filter((u) => u.endsWith("/reportees")).length, 1);

  const participants = calls.filter((c) => c.url.endsWith("/participants"))
    .map((c) => new URLSearchParams(String(c.init.body)));
  assert.equal(participants[0].get("email"), "rep@example.com", "並べた順に足す（末尾に追加＝署名の順番）");
  assert.equal(participants[1].get("name"), "部長 花子");
  assert.equal(participants[0].get("order"), null, "CloudSign の宛先に無い項目は送らない");

  const reportee = new URLSearchParams(String(
    calls.find((c) => c.url.endsWith("/reportees"))!.init.body));
  assert.equal(reportee.get("email"), "cc@arclight.co.jp");
});

test("CloudSign：署名者を書かなければ、宛先を1人の署名者として扱う", async () => {
  const { calls, impl } = recorder();
  const adapter = new CloudSignAdapter("client", "https://cs.test", impl);
  await adapter.send({ recipient: "only@example.com", subject: "件名", body: "本文",
                       attachment: pdf("one.pdf") });
  const participants = calls.filter((c) => c.url.endsWith("/participants"));
  assert.equal(participants.length, 1);
  assert.equal(new URLSearchParams(String(participants[0].init.body)).get("email"),
               "only@example.com");
});

test("CloudSign：autoSend を立てたときだけ、作ったその場で送る", async () => {
  const { calls, impl } = recorder();
  const adapter = new CloudSignAdapter("client", "https://cs.test", impl, { autoSend: true });
  const receipt = await adapter.send({ recipient: "only@example.com", subject: "件名", body: "本文",
                                       attachment: pdf("one.pdf") });
  assert.notEqual(receipt.draft, true);
  assert.ok(calls.some((c) => /\/documents\/[^/]+$/.test(c.url) && c.init.method === "POST"), "送信の POST がある");
});

test("CloudSign：書類が無ければ送らない", async () => {
  const { impl } = recorder();
  const adapter = new CloudSignAdapter("client", "https://cs.test", impl);
  await assert.rejects(
    () => adapter.send({ recipient: "a@example.com", body: "本文" }), /書類が必要/);
});

const cloudsignStub = (docOnRead: Record<string, unknown>) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const u = String(url);
    const body = u.includes("/token") ? { access_token: "t" }
      : /\/documents\/doc-1$/.test(u) && !init.method ? docOnRead
      : u.endsWith("/documents") ? { id: "doc-1" } : {};
    return { ok: true, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, impl };
};
const signRequest: DispatchRequest = {
  recipient: "rep@example.com", subject: "s", body: "b", attachment: pdf("a.pdf"),
  participants: [{ email: "rep@example.com", name: "代表" }], reportees: [{ email: "cc@arclight.co.jp" }]
};

test("CloudSign：作ったあと書類を読み戻し、宛先が入っていれば警告しない", async () => {
  const { impl } = cloudsignStub({ participants: [{ email: "me@arclight.co.jp" }, { email: "REP@example.com" }],
                                   reportees: [{ email: "cc@arclight.co.jp" }] });
  const r = await new CloudSignAdapter("client", "https://cs.test", impl).send(signRequest);
  assert.equal(r.warnings, undefined);
  assert.deepEqual((r.raw as any).confirmed.participants, ["me@arclight.co.jp", "rep@example.com"]);
});

test("CloudSign：読み戻して宛先が入っていなければ、どの宛先かを警告する（下書きは残す）", async () => {
  const { impl } = cloudsignStub({ participants: [{ email: "me@arclight.co.jp" }], reportees: [] });
  const r = await new CloudSignAdapter("client", "https://cs.test", impl).send(signRequest);
  assert.equal(r.draft, true);
  assert.match(r.warnings![0], /rep@example\.com、cc:cc@arclight\.co\.jp/);
});

test("CloudSign：断られたら、どこで・何と言われたかを画面に出せる形で返す", async () => {
  const { DomainError } = await import("../core/errors.js");
  const impl = (async (url: string) => {
    const u = String(url);
    if (u.endsWith("/participants")) return { ok: false, status: 400, text: async () => '{"message":"email is invalid"}' } as unknown as Response;
    return { ok: true, json: async () => (u.includes("/token") ? { access_token: "t" } : { id: "doc-9" }) } as unknown as Response;
  }) as unknown as typeof fetch;
  await assert.rejects(() => new CloudSignAdapter("client", "https://cs.test", impl).send(signRequest),
    (e: unknown) => e instanceof DomainError && /署名者 rep@example\.com を下書き doc-9/.test(e.message) && /email is invalid/.test(e.message));
});
