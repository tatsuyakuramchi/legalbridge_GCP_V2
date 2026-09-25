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

// ---- 新しいメールは受付箱へ（docs/v3-request-inbox.md）----

const queued = (database: FakeDatabase) => database.find("INSERT INTO intake_requests")!;

test("どの案件にも当たらない新しいメールは、案件を立てずに受付箱に入れる", async () => {
  const database = db({ "INSERT INTO intake_requests": [{ id: 9 }] });
  const r = await new EmailIntakeService(database).accept(mail());
  assert.equal(r.action, "queued");
  assert.equal(r.requestId, 9);
  assert.equal(r.requestNo, "REQ-2026-00219");
  assert.equal(database.find("INSERT INTO matters"), undefined, "受け付けるまで案件は立てない");
  const q = queued(database);
  assert.match(q.text, /'email', 'new'/);
  assert.equal(q.params[9], "t1", "スレッドを控える（受付で案件に繋ぐ）");
  assert.equal(q.params[10], "m1");
  assert.match(String(q.params[11]), /よろしくお願いします。/, "原文を写しとして持つ");
});

test("差出人が1件に決まるときだけ相手先を推す", async () => {
  const database = db({ "FROM party_contacts pc": [{ id: 3 }], "INSERT INTO intake_requests": [{ id: 9 }] });
  const r = await new EmailIntakeService(database).accept(mail());
  assert.equal(r.counterpartyId, 3);
  assert.equal(queued(database).params[5], 3);

  const two = db({ "FROM party_contacts pc": [{ id: 3 }, { id: 4 }], "INSERT INTO intake_requests": [{ id: 9 }] });
  assert.equal((await new EmailIntakeService(two).accept(mail())).counterpartyId, null, "2件当たったら決めない");
});

test("取引先は決して作らない（表記ゆれがマスタに増える経路を塞ぐ）", async () => {
  const database = db({ "INSERT INTO intake_requests": [{ id: 9 }] });
  await new EmailIntakeService(database).accept(mail());
  assert.equal(database.find("INSERT INTO parties"), undefined);
});

test("社内からの転送は依頼者として記録し、Slack の宛先も引く。相手先は探さない", async () => {
  const database = db({
    "FROM staff WHERE lower(email)": [{ id: 2, name: "法務 太郎", slack_user_id: "U777" }],
    "INSERT INTO intake_requests": [{ id: 9 }]
  });
  const r = await new EmailIntakeService(database).accept(mail());
  assert.equal(r.counterpartyId, null);
  assert.equal(database.find("FROM party_contacts pc"), undefined, "社内の人を取引先に当てない");
  const q = queued(database);
  assert.equal(q.params[4], null, "相手先の記載にしない");
  assert.deepEqual(q.params.slice(6, 9), ["tanaka@example.co.jp", "法務 太郎", "U777"]);
});

test("発注の言葉があれば業務委託として推す", async () => {
  const database = db({ "INSERT INTO intake_requests": [{ id: 9 }] });
  await new EmailIntakeService(database).accept(mail());
  assert.equal(queued(database).params[1], "outsourcing");
});

test("受付前の依頼と同じスレッドの続きは、新しい依頼にせず書き足す", async () => {
  const database = db({ "WHERE email_thread_id = $1": [{ id: 9, request_no: "REQ-2026-00100" }] });
  const r = await new EmailIntakeService(database).accept(mail({ messageId: "m2", subject: "Re: イラスト制作の発注について" }));
  assert.equal(r.action, "appended");
  assert.equal(r.requestNo, "REQ-2026-00100");
  assert.equal(database.find("INSERT INTO intake_requests"), undefined);
  const upd = database.find("SET source_payload = jsonb_set")!;
  assert.equal(upd.params[0], 9);
  assert.match(String(upd.params[1]), /"messageId":"m2"/);
});

test("案件に当たったメールは、案件のやり取りとして本文ごと残す", async () => {
  const linked = db({ "target_type = 'email_thread'": [{ id: 42, matter_no: "MTR-2026-00219" }] });
  await new EmailIntakeService(linked).accept(mail({
    messageId: "m2", attachments: [{ filename: "draft.pdf", mimeType: "application/pdf", size: 10 }] }));
  const kept = linked.find("INSERT INTO matter_communications")!;
  assert.equal(kept.params[0], 42);
  assert.equal(kept.params[1], "email");
  assert.equal(kept.params[2], "in");
  assert.equal(kept.params[4], "tanaka@example.co.jp");
  assert.equal(kept.params[6], "イラスト制作の発注について");
  assert.equal(kept.params[7], "よろしくお願いします。");
  assert.equal(kept.params[8], "m2", "メッセージIDで二度書かない");
  assert.match(String(kept.params[11]), /draft\.pdf/, "添付の一覧も証憑に入れる");
});
