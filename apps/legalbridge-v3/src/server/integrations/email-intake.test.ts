import test from "node:test";
import assert from "node:assert/strict";
import {
  describeMail, inferKind, isMachineMail, normalizeSubject, parseAddress, readMail,
  type InboundMail
} from "./email-intake.js";

const mail = (over: Partial<InboundMail> = {}): InboundMail => ({
  messageId: "m1", threadId: "t1", rfcMessageId: "<a@b>",
  from: "田中 <tanaka@example.co.jp>", fromName: null, to: ["legal@arch.co.jp"],
  subject: "イラスト制作のご依頼", body: "よろしくお願いします。",
  receivedAt: "2026-09-01T02:00:00.000Z", attachments: [], ...over
});

test("差出人は表示名とアドレスに分ける", () => {
  assert.deepEqual(parseAddress("田中 <Tanaka@Example.co.jp>"),
    { email: "tanaka@example.co.jp", name: "田中" });
  assert.deepEqual(parseAddress('"山田, 花子" <y@e.jp>'),
    { email: "y@e.jp", name: "山田, 花子" });
  assert.deepEqual(parseAddress("plain@e.jp"), { email: "plain@e.jp", name: null });
});

test("Re: と Fwd: が重なっても剥がす", () => {
  assert.equal(normalizeSubject("Re: Fwd: RE: 契約書の件"), "契約書の件");
  assert.equal(normalizeSubject("Re[2]: 契約書の件"), "契約書の件");
  assert.equal(normalizeSubject("契約書の件"), "契約書の件");
});

test("自動返信と不達通知は取り込まない", () => {
  assert.equal(isMachineMail(mail({ subject: "自動返信: 不在にしております" })), true);
  assert.equal(isMachineMail(mail({ subject: "Out of Office" })), true);
  assert.equal(isMachineMail(mail({ from: "MAILER-DAEMON@example.jp", subject: "x" })), true);
  assert.equal(isMachineMail(mail({ from: "no-reply@example.jp", subject: "x" })), true);
  assert.equal(isMachineMail(mail()), false);
});

test("発注の言葉があれば業務委託、許諾の言葉があれば作品", () => {
  assert.equal(inferKind("発注書をお送りします"), "outsourcing");
  assert.equal(inferKind("キャラクターの二次利用の許諾について"), "work");
  assert.equal(inferKind("NDAのご確認"), "single");
  // 両方出てきたら、金を払う側の話として扱う。
  assert.equal(inferKind("許諾に伴う発注書"), "outsourcing");
});

test("件名・本文の案件番号を拾う", () => {
  const r = readMail(mail({ subject: "Re: [MTR-2026-00219] 契約書の件" }));
  assert.equal(r.matterNo, "MTR-2026-00219");
  assert.equal(r.title, "[MTR-2026-00219] 契約書の件");
});

test("文書番号も拾う。こちらが出した書面への返信を見分けるため", () => {
  const r = readMail(mail({ body: "ARC-LIC-2026-0003 について確認しました" }));
  assert.equal(r.documentNo, "ARC-LIC-2026-0003");
  assert.equal(r.matterNo, null);
});

test("件名が空でも案件名は空にしない", () => {
  assert.equal(readMail(mail({ subject: "" })).title, "（件名なし）");
});

test("備考には本文をそのまま入れず、長さを切る", () => {
  const long = "あ".repeat(2000);
  const m = mail({ body: long, attachments: [{ filename: "契約書.pdf", mimeType: "application/pdf", size: 100 }] });
  const text = describeMail(m, readMail(m));
  assert.ok(text.includes("契約書.pdf"), "添付の名前は残す");
  assert.ok(text.includes("tanaka@example.co.jp"));
  assert.ok(text.length < 1200, `本文が切られていない: ${text.length}`);
});
