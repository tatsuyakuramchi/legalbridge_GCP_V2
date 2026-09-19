import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { DispatchService } from "../integrations/dispatch-service.js";
import { MemoryAdapter } from "../integrations/adapters.js";
import { MatterCommunicationService, driveIdFromUrl, recordCommunication } from "./communication-service.js";

const live = { mode: "live" as const, adapterConfigured: true, readOnly: false };

/** 案件 7。担当者未設定、依頼者は Slack の U01。スレッドはまだ無い。 */
const build = (over: Record<string, Array<Record<string, unknown>>> = {}, mode: "live" | "off" = "live") => {
  const db = new FakeDatabase((t) => {
    for (const [fragment, rows] of Object.entries(over)) if (t.includes(fragment)) return rows;
    if (t.includes("FROM matters WHERE id")) {
      return [{ id: 7, matter_no: "MTR-2026-00270", title: "挿絵", owner_staff_id: 3,
                counterparty_id: 2, requester_email: null, requester_slack_id: "U01" }];
    }
    if (t.includes("INSERT INTO matter_communications")) return [{ id: 91 }];
    if (t.includes("FROM matter_communications c")) {
      return [{ id: 91, matter_id: 7, channel: "slack", direction: "out", occurred_at: "2026-09-09T01:00:00Z",
                actor: "kuramochi", counterpart: "U01", subject: null, body: "確認お願いします",
                external_ref: "U01:1757.001", external_url: null, document_id: null, document_no: null,
                evidence: {} }];
    }
    return [];
  });
  const slack = new MemoryAdapter("slack");
  const gmail = new MemoryAdapter("gmail");
  const dispatch = new DispatchService(db, { slack, gmail }, () => ({ ...live, mode }));
  return { db, slack, gmail, svc: new MatterCommunicationService(db, dispatch) };
};

test("Slack は 指定 → 案件のスレッド → 依頼者の DM の順に宛先を決め、最初の1通をスレッドの根にする", async () => {
  const { db, slack, svc } = build();
  const r = await svc.sendSlack(7, { body: "確認お願いします" }, "kuramochi");

  assert.equal(r.outcome.sent, true);
  assert.equal(slack.sent[0].recipient, "U01", "スレッドが無いので依頼者の DM へ");
  assert.equal(slack.sent[0].threadRef, null);
  const link = db.find("INSERT INTO matter_links")!;
  assert.equal(link.params[1], "U01:slack-1", "送った ts をスレッドの根として控える");
  const kept = db.find("INSERT INTO matter_communications")!;
  assert.equal(kept.params[1], "slack");
  assert.equal(kept.params[2], "out");
  assert.equal(kept.params[7], "確認お願いします", "本文をそのまま残す");
  assert.equal(kept.params[8], "U01:slack-1");
  assert.equal(r.communication?.id, 91);
});

test("スレッドがあればその下に付け、根は作り直さない", async () => {
  const { db, slack, svc } = build({
    "target_type = 'slack_thread'": [{ target_ref: "C99:1700.5", snapshot: { channelId: "C99", threadTs: "1700.5" } }]
  });
  await svc.sendSlack(7, { body: "続きです" }, "k");
  assert.equal(slack.sent[0].recipient, "C99");
  assert.equal(slack.sent[0].threadRef, "1700.5");
  assert.equal(db.find("INSERT INTO matter_links"), undefined);
});

test("ゲートで止まったら記録しない（送っていないものを時系列に残さない）", async () => {
  const { db, slack, svc } = build({}, "off");
  const r = await svc.sendSlack(7, { body: "x" }, "k");
  assert.equal(r.outcome.sent, false);
  assert.equal(slack.sent.length, 0);
  assert.equal(r.communication, null);
  assert.equal(db.find("INSERT INTO matter_communications"), undefined);
});

test("メールは to と cc を分けて送り、案件のスレッドに続ける", async () => {
  const { db, gmail, svc } = build({
    "target_type = 'email_thread'": [{ target_ref: "thr-1" }]
  });
  const r = await svc.sendEmail(7, {
    to: ["asai@example.test"], cc: ["kuramochi@arclight.co.jp", "asai@example.test"],
    subject: "発注書のご確認", body: "添付をご確認ください", documentId: 15
  }, "kuramochi");
  assert.equal(r.outcome.sent, true);
  assert.equal(gmail.sent[0].recipient, "asai@example.test");
  assert.deepEqual(gmail.sent[0].cc, ["kuramochi@arclight.co.jp"], "to と同じ宛先は cc から落とす");
  assert.equal(gmail.sent[0].threadRef, "thr-1", "既にあるスレッドへ続ける");
  const kept = db.find("INSERT INTO matter_communications")!;
  assert.equal(kept.params[1], "email");
  assert.match(String(kept.params[5]), /cc:kuramochi/);
  assert.equal(kept.params[10], 15, "文書を添えたなら、その文書に結ぶ");
});

test("メールは宛先・件名・本文が無いと送らない", async () => {
  const { svc } = build();
  await assert.rejects(() => svc.sendEmail(7, { to: [], subject: "a", body: "b" }, "k"), /宛先/);
  await assert.rejects(() => svc.sendEmail(7, { to: ["a@b.test"], subject: " ", body: "b" }, "k"), /件名/);
});

test("Drive のリンクは ID を取り出して残す。同じファイルは二度残さない", () => {
  assert.equal(driveIdFromUrl("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing"), "1AbCdEfGhIjKlMnOp");
  assert.equal(driveIdFromUrl("https://drive.google.com/drive/folders/1QrStUvWxYz012345"), "1QrStUvWxYz012345");
  assert.equal(driveIdFromUrl("https://docs.google.com/document/d/1DocIdDocIdDocId/edit"), "1DocIdDocIdDocId");
  assert.equal(driveIdFromUrl("https://example.com/x"), null);
});

test("Drive のリンクが読めなければ残さない", async () => {
  const { svc } = build();
  await assert.rejects(
    () => svc.linkDrive(7, { url: "https://example.com/", direction: "in" }, "k"), /Drive のリンクとして読めません/);
});

test("同じ外部IDは二度書かない（webhook の再送で増えない）", async () => {
  const db = new FakeDatabase((t) => t.includes("INSERT INTO matter_communications") ? [] : undefined);
  const id = await recordCommunication(db, {
    matterId: 7, channel: "slack", direction: "in", actor: "U01", externalRef: "C1:1.0"
  });
  assert.equal(id, null);
  assert.match(db.find("INSERT INTO matter_communications")!.text, /ON CONFLICT \(channel, external_ref\)/);
});
