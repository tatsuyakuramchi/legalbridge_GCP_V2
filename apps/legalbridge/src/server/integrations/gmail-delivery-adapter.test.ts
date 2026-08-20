import assert from "node:assert/strict";
import test from "node:test";
import { buildRawMessage, encodeHeaderWord, isValidEmail, parseRecipientList } from "./gmail-delivery-adapter.js";

test("メールアドレスの妥当性を判定する", () => {
  assert.equal(isValidEmail("a@example.com"), true);
  assert.equal(isValidEmail("bad"), false);
  assert.equal(isValidEmail(""), false);
});

test("非ASCIIヘッダはRFC2047でエンコードする", () => {
  assert.equal(encodeHeaderWord("Legal"), "Legal");
  assert.equal(encodeHeaderWord("契約"), `=?UTF-8?B?${Buffer.from("契約", "utf-8").toString("base64")}?=`);
});

test("RFC822メッセージをbase64urlで組み立てる", () => {
  const raw = buildRawMessage({
    to: "to@example.com", subject: "確定のお知らせ", bodyText: "本文です",
    fromEmail: "legal@arclight.co.jp", fromName: "LegalBridge", idempotencyKey: "k"
  });
  assert.doesNotMatch(raw, /[+/=]/); // base64url（+ / = を含まない）
  const decoded = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
  assert.match(decoded, /To: to@example.com/);
  assert.match(decoded, /Subject: =\?UTF-8\?B\?/);
  assert.match(decoded, /Content-Transfer-Encoding: base64/);
  const body = decoded.split("\r\n\r\n")[1];
  assert.equal(Buffer.from(body, "base64").toString("utf-8"), "本文です");
});

test("カンマ区切り宛先を正規化する（trim・空除去・大小無視の重複除去）", () => {
  assert.deepEqual(parseRecipientList("a@x.com, b@y.com , A@x.com,,"), ["a@x.com", "b@y.com"]);
  assert.deepEqual(parseRecipientList(""), []);
});

test("CCヘッダと複数宛先をそのまま載せる", () => {
  const raw = buildRawMessage({
    to: "a@x.com, b@y.com", cc: "c@z.com", subject: "Hello", bodyText: "hi",
    fromEmail: "legal@arclight.co.jp", idempotencyKey: "k"
  });
  const decoded = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
  assert.match(decoded, /To: a@x\.com, b@y\.com/);
  assert.match(decoded, /Cc: c@z\.com/);
});

test("添付ありは multipart/mixed で本文とPDFパートを組む", () => {
  const pdf = Buffer.from("%PDF-1.4 fake pdf content");
  const raw = buildRawMessage({
    to: "to@example.com", subject: "検収書のご送付", bodyText: "本文です",
    fromEmail: "legal@arclight.co.jp", fromName: "LegalBridge",
    idempotencyKey: "abcdef0123456789abcdef0123456789",
    attachments: [{ filename: "ARC-AC-2026-0008.pdf", content: pdf, mimeType: "application/pdf" }]
  });
  assert.doesNotMatch(raw, /[+/=]/);
  const decoded = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
  assert.match(decoded, /Content-Type: multipart\/mixed; boundary="=_lb_abcdef0123456789abcdef01"/);
  assert.match(decoded, /Content-Type: text\/plain; charset="UTF-8"/);
  assert.match(decoded, /Content-Type: application\/pdf; name="ARC-AC-2026-0008\.pdf"/);
  assert.match(decoded, /Content-Disposition: attachment; filename="ARC-AC-2026-0008\.pdf"/);
  // 添付本体が base64 で入っている（折返しを除去して復元できる）。
  const attachmentPart = decoded.split('Content-Disposition: attachment; filename="ARC-AC-2026-0008.pdf"')[1];
  const base64Body = attachmentPart.split("\r\n\r\n")[1].split("\r\n--")[0].replace(/\r\n/g, "");
  assert.equal(Buffer.from(base64Body, "base64").toString("utf-8"), "%PDF-1.4 fake pdf content");
  // 終端境界で閉じる。
  assert.match(decoded, /--=_lb_abcdef0123456789abcdef01--/);
});
