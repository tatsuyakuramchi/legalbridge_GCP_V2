import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { EmailIntakeService } from "./email-intake-service.js";
import type { InboundMail } from "./email-intake.js";

const mail = (over: Partial<InboundMail> = {}): InboundMail => ({
  messageId: "m1", threadId: "t1", rfcMessageId: "<a@b>",
  from: "田中 <tanaka@example.co.jp>", fromName: null, to: ["legal@arch.co.jp"],
  subject: "イラスト制作の発注について", body: "よろしくお願いします。",
  receivedAt: "2026-09-01T02:00:00.000Z", attachments: [], ...over
});

/** 既定は「初めて見るメール・スレッド未登録・差出人は社外で該当なし」。 */
const db = (over: Record<string, Array<Record<string, unknown>>> = {}) =>
  new FakeDatabase((t) => {
    for (const [fragment, rows] of Object.entries(over)) {
      if (t.includes(fragment)) return rows;
    }
    if (t.includes("UPDATE document_sequences")) return [{ current_value: 219 }];
    if (t.includes("INSERT INTO matters")) return [{ id: 42, matter_no: "MTR-2026-00219" }];
    return [];
  });

test("自動返信はデータベースに触れずに捨てる", async () => {
  const database = db();
  const r = await new EmailIntakeService(database).accept(
    mail({ subject: "自動返信: 不在にしております" }));
  assert.equal(r.action, "skipped");
  assert.equal(database.queries.length, 0, "毎日届くものを監査に積まない");
});

test("同じメッセージIDは二度取り込まない", async () => {
  const database = db({ "FROM audit_events": [{ "?column?": 1 }] });
  const r = await new EmailIntakeService(database).accept(mail());
  assert.equal(r.action, "duplicate");
  assert.equal(database.find("INSERT INTO matters"), undefined);
});

test("同じスレッドの続きは案件を立てず紐づける", async () => {
  const database = db({
    "l.target_type = 'email_thread'": [{ id: 7, matter_no: "MTR-2026-00100" }]
  });
  const r = await new EmailIntakeService(database).accept(mail());

  assert.equal(r.action, "linked");
  assert.equal(r.matterId, 7);
  assert.equal(database.find("INSERT INTO matters"), undefined, "二重に案件を立てない");
  assert.ok(database.find("INSERT INTO matter_links")!.text.includes("DO UPDATE"));
});

test("件名の案件番号で既存の案件に寄せる", async () => {
  const database = db({
    "SELECT id, matter_no FROM matters WHERE matter_no": [{ id: 9, matter_no: "MTR-2026-00219" }]
  });
  const r = await new EmailIntakeService(database).accept(
    mail({ threadId: "", subject: "Re: [MTR-2026-00219] 契約書の件" }));
  assert.equal(r.action, "linked");
  assert.equal(r.matterId, 9);
});

test("こちらが出した文書番号への返信も同じ案件に寄せる", async () => {
  const database = db({
    "FROM documents d JOIN matters m": [{ id: 11, matter_no: "MTR-2026-00050" }]
  });
  const r = await new EmailIntakeService(database).accept(
    mail({ threadId: "", body: "ARC-LIC-2026-0003 の件です" }));
  assert.equal(r.action, "linked");
  assert.equal(r.matterId, 11);
});

test("差出人が1件に決まるときだけ相手先を紐づける", async () => {
  const database = db({ "FROM party_contacts pc": [{ id: 3 }] });
  const r = await new EmailIntakeService(database).accept(mail());

  assert.equal(r.action, "created");
  assert.equal(r.counterpartyId, 3);
  assert.equal(database.find("INSERT INTO matters")!.params[3], 3);
  assert.equal(database.find("INSERT INTO data_quality_issues"), undefined);
});

test("2件当たったら決めない。課題として残す", async () => {
  const database = db({ "FROM party_contacts pc": [{ id: 3 }, { id: 4 }] });
  const r = await new EmailIntakeService(database).accept(mail());

  assert.equal(r.counterpartyId, null);
  const issue = database.find("INSERT INTO data_quality_issues")!;
  assert.equal(issue.params[0], 42);
  assert.match(issue.text, /MAIL_SENDER_UNRESOLVED/);
});

test("取引先は決して作らない（表記ゆれがマスタに増える経路を塞ぐ）", async () => {
  const database = db();
  await new EmailIntakeService(database).accept(mail());
  assert.equal(database.find("INSERT INTO parties"), undefined);
});

test("社内からの転送は依頼者として記録し、相手先を探さない", async () => {
  const database = db({
    "FROM staff WHERE lower(email)": [{ id: 2, name: "法務 太郎" }]
  });
  const r = await new EmailIntakeService(database).accept(mail());

  assert.equal(r.counterpartyId, null);
  assert.equal(database.find("FROM party_contacts pc"), undefined, "社内の人を取引先に当てない");
  assert.equal(database.find("INSERT INTO matters")!.params[4], "tanaka@example.co.jp");
  assert.equal(database.find("INSERT INTO data_quality_issues"), undefined,
    "社内からの転送は差出人が不明なわけではない");
});

test("発注の言葉があれば業務委託の案件として立てる", async () => {
  const database = db();
  await new EmailIntakeService(database).accept(mail());
  assert.equal(database.find("INSERT INTO matters")!.params[2], "outsourcing");
});

test("添付の名前は案件に残す", async () => {
  const database = db();
  await new EmailIntakeService(database).accept(mail({
    attachments: [{ filename: "業務委託契約書.pdf", mimeType: "application/pdf", size: 1 }]
  }));
  assert.match(String(database.find("INSERT INTO matters")!.params[5]), /業務委託契約書\.pdf/);
  assert.match(String(database.find("INSERT INTO matter_links")!.params[2]), /業務委託契約書\.pdf/);
});

test("受け取ったメールは案件のやり取りとして本文ごと残す（新規でも紐づけでも）", async () => {
  const created = db();
  await new EmailIntakeService(created).accept(mail({ attachments: [{ filename: "draft.pdf", mimeType: "application/pdf", size: 10 }] }));
  const kept = created.find("INSERT INTO matter_communications")!;
  assert.equal(kept.params[0], 42);
  assert.equal(kept.params[1], "email");
  assert.equal(kept.params[2], "in");
  assert.equal(kept.params[4], "tanaka@example.co.jp");
  assert.equal(kept.params[6], "イラスト制作の発注について");
  assert.equal(kept.params[7], "よろしくお願いします。");
  assert.equal(kept.params[8], "m1", "メッセージIDで二度書かない");
  assert.match(String(kept.params[11]), /draft\.pdf/, "添付の一覧も証憑に入れる");

  const linked = db({ "target_type = 'email_thread'": [{ id: 42, matter_no: "MTR-2026-00219" }] });
  await new EmailIntakeService(linked).accept(mail({ messageId: "m2" }));
  assert.equal(linked.find("INSERT INTO matter_communications")!.params[8], "m2");
});
