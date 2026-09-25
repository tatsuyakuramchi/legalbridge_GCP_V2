import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { DocumentSendService } from "./send-service.js";

const ev = (action: string, at: string, detail: Record<string, unknown> = {}, actor = "kuramochi") =>
  ({ occurred_at: at, action, actor, detail });

const build = (events: Array<Record<string, unknown>>, agreement: string | null = "negotiating") =>
  new FakeDatabase((t) => {
    if (t.includes("FROM documents d LEFT JOIN agreements")) {
      return [{ id: 5, status: "issued", agreement_id: agreement ? 8 : null, agreement_status: agreement }];
    }
    if (t.includes("FROM audit_events")) return events;
    return undefined;
  });

test("何も送っていなければ、次は CloudSign（確認メールは任意なので飛ばせる）", async () => {
  const t = await new DocumentSendService(build([])).timeline(5);
  assert.deepEqual(t.steps.map((s) => s.done), [false, false, false, false]);
  assert.equal(t.current?.key, "cloudsign");
  assert.equal(t.steps[0].optional, true);
});

test("送信・確認・署名依頼の記録から段が埋まる", async () => {
  const t = await new DocumentSendService(build([
    ev("gmail.send", "2026-09-01T00:00:00Z", { recipient: "asai@example.test" }),
    ev("document.confirmed", "2026-09-02T00:00:00Z", { via: "メールの返信", note: "問題なし" }),
    ev("cloudsign.send", "2026-09-03T00:00:00Z", { recipient: "asai@example.test", externalId: "cs-9" })
  ])).timeline(5);
  assert.deepEqual(t.steps.map((s) => s.done), [true, true, true, false]);
  assert.match(t.steps[0].detail, /asai@example.test へ送付/);
  assert.match(t.steps[1].detail, /メールの返信で確認をもらった：問題なし/);
  assert.match(t.steps[2].detail, /CloudSign #cs-9/);
  assert.equal(t.current?.key, "executed");
  assert.equal(t.events.length, 3);
});

test("締結は合意の状態から見る。webhook が反映した日時を根拠にする", async () => {
  const t = await new DocumentSendService(build([
    ev("cloudsign.send", "2026-09-03T00:00:00Z", { recipient: "a@b.test", externalId: "cs-9" }),
    ev("cloudsign.applied", "2026-09-05T00:00:00Z", { documentId: 5, applied: true, status: "executed" }, "system")
  ], "executed")).timeline(5);
  assert.equal(t.steps[3].done, true);
  assert.equal(t.steps[3].at, "2026-09-05T00:00:00.000Z");
  assert.equal(t.current, null, "全部済んだ");
});

test("合意に繋がっていない文書は、締結を記録できないと言う", async () => {
  const t = await new DocumentSendService(build([], null)).timeline(5);
  assert.match(t.steps[3].detail, /合意に繋がっていない/);
});

test("相手の確認は決定済みの文書にだけ記録し、案件のやり取りにも残す", async () => {
  const db = new FakeDatabase((t) => {
    if (t.includes("FROM documents WHERE id")) return [{ id: 5, document_no: "ARC-PO-2026-0007", status: "issued", matter_id: 3 }];
    if (t.includes("INSERT INTO matter_communications")) return [{ id: 1 }];
    return undefined;
  });
  await new DocumentSendService(db).confirm(5, { via: "電話", note: "9/12 に返送" }, "kuramochi");
  const audit = db.find("INSERT INTO audit_events")!;
  assert.equal(audit.params[1], "document.confirmed");
  assert.match(String(audit.params[5]), /電話/);
  const kept = db.find("INSERT INTO matter_communications")!;
  assert.equal(kept.params[0], 3);
  assert.equal(kept.params[2], "in");
  assert.match(String(kept.params[7]), /電話で確認をもらった：9\/12 に返送/);
  assert.equal(kept.params[10], 5);
});

test("下書きには確認を記録できない", async () => {
  const db = new FakeDatabase((t) =>
    t.includes("FROM documents WHERE id") ? [{ id: 5, status: "draft", matter_id: null }] : undefined);
  await assert.rejects(() => new DocumentSendService(db).confirm(5, { via: "電話" }, "k"), /決定済みの文書だけ/);
});

/**
 * 予備系では CloudSign 連携が無い。CloudSign の画面から直接送ったぶんを手で記録すると、
 * 連携で送ったときと同じ cloudsign.send が残り、段が進む。
 */
const manualDb = (status = "issued", agreementId: number | null = 8) => new FakeDatabase((t) => {
  if (t.includes("FROM documents d LEFT JOIN agreements a ON a.id = d.agreement_id\n            WHERE d.id = $1 FOR UPDATE")) {
    return [{ id: 5, document_no: "ARC-PO-2026-0007", status, matter_id: 3, agreement_id: agreementId, agreement_status: agreementId ? "negotiating" : null }];
  }
  if (t.includes("UPDATE agreements")) return [{ id: 8 }];
  if (t.includes("INSERT INTO matter_communications")) return [{ id: 1 }];
  return undefined;
});

test("CloudSign で送ったと手で記録すると cloudsign.send（manual）が残り、案件のやり取りにも残る", async () => {
  const db = manualDb();
  const r = await new DocumentSendService(db).recordCloudSign(5,
    { status: "sent", at: "2026-09-10", signer: "asai@example.test", externalId: "cs-77", note: "先方の担当へ" }, "kuramochi");
  assert.equal(r.status, "sent");
  const audit = db.find("INSERT INTO audit_events")!;
  assert.equal(audit.params[1], "cloudsign.send");
  assert.equal(audit.params[2], "document");
  assert.equal(audit.params[3], 5);
  const detail = JSON.parse(String(audit.params[5]));
  assert.equal(detail.manual, true);
  assert.equal(detail.recipient, "asai@example.test");
  assert.equal(detail.externalId, "cs-77");
  assert.match(String(audit.params[6]), /^2026-09-10/, "出来事の日時は記録した日付");
  const kept = db.find("INSERT INTO matter_communications")!;
  assert.equal(kept.params[0], 3);
  assert.equal(kept.params[1], "cloudsign");
  assert.equal(kept.params[2], "out");
  assert.equal(db.find("UPDATE agreements"), undefined, "送っただけでは合意は動かさない");
});

test("締結を手で記録すると合意が executed になり、cloudsign.applied（manual）が残る", async () => {
  const db = manualDb();
  const r = await new DocumentSendService(db).recordCloudSign(5, { status: "executed", at: "2026-09-12" }, "kuramochi");
  assert.equal(r.status, "executed");
  assert.equal(r.agreementUpdated, true);
  const upd = db.find("UPDATE agreements")!;
  assert.equal(upd.params[0], 8);
  assert.equal(upd.params[1], "executed");
  assert.equal(upd.params[2], "2026-09-12");
  const audit = db.find("INSERT INTO audit_events")!;
  assert.equal(audit.params[1], "cloudsign.applied");
  const detail = JSON.parse(String(audit.params[5]));
  assert.equal(detail.manual, true);
  assert.equal(detail.applied, true);
  assert.equal(detail.documentId, 5);
  const kept = db.find("INSERT INTO matter_communications")!;
  assert.equal(kept.params[2], "in");
  assert.match(String(kept.params[7]), /締結した（手で記録）/);
});

test("合意に繋がっていない文書の締結は、合意を動かさず文書の状態としてだけ残る。下書きには何も記録できない", async () => {
  const db = manualDb("issued", null);
  const r = await new DocumentSendService(db).recordCloudSign(5, { status: "executed", at: "2026-09-12" }, "k");
  assert.equal(r.status, "executed");
  assert.equal(r.agreementUpdated, false);
  assert.equal(db.find("UPDATE agreements"), undefined, "合意が無いので動かすものが無い");
  const audit = db.find("INSERT INTO audit_events")!;
  assert.equal(audit.params[1], "cloudsign.applied");
  assert.equal(audit.params[3], 5);
  const detail = JSON.parse(String(audit.params[5]));
  assert.equal(detail.status, "executed");
  assert.equal(detail.applied, true);
  assert.match(String(detail.reason), /文書の状態としてだけ/);
  await assert.rejects(
    () => new DocumentSendService(manualDb("draft")).recordCloudSign(5, { status: "sent" }, "k"),
    /決定済みの文書だけ/);
});

test("手で記録した署名依頼と締結は、段の説明に「手で記録」と出る", async () => {
  const t = await new DocumentSendService(build([
    ev("cloudsign.send", "2026-09-10T00:00:00Z", { recipient: "asai@example.test", manual: true }),
    ev("cloudsign.applied", "2026-09-12T00:00:00Z", { documentId: 5, applied: true, status: "executed", manual: true })
  ], "executed")).timeline(5);
  assert.match(t.steps[2].detail, /システム外で送付/);
  assert.match(t.steps[3].detail, /手で記録/);
  assert.equal(t.hasAgreement, true);
});

test("未送信に戻すと cloudsign.applied（status=unsent・manual）が残り、合意は動かさない", async () => {
  const db = manualDb();
  const r = await new DocumentSendService(db).recordCloudSign(5, { status: "unsent", at: "2026-09-20", note: "送っていなかった" }, "k");
  assert.equal(r.status, "unsent");
  assert.equal(r.agreementUpdated, false);
  assert.equal(db.find("UPDATE agreements"), undefined);
  const audit = db.find("INSERT INTO audit_events")!;
  assert.equal(audit.params[1], "cloudsign.applied");
  const detail = JSON.parse(String(audit.params[5]));
  assert.equal(detail.manual, true);
  assert.equal(detail.status, "unsent");
  assert.match(String(audit.params[6]), /^2026-09-20/);
  assert.ok(db.find("INSERT INTO matter_communications"), "やり取りにも残す");
});
