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
