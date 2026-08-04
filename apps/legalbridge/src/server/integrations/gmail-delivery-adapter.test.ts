import assert from "node:assert/strict";
import test from "node:test";
import { buildRawMessage, encodeHeaderWord, isValidEmail } from "./gmail-delivery-adapter.js";

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
