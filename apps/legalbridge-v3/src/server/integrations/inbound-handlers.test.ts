import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { applyInbound, handleCloudSign, mapCloudSignStatus } from "./inbound-handlers.js";

const sent = (over: Record<string, unknown> = {}) => ({
  document_id: 7, document_no: "ARC-LIC-2026-0003", agreement_id: 4, ...over
});

const build = (rows: any[], updated: any[] = [{ agreement_no: "AGR-4", status: "executed" }]) =>
  new FakeDatabase((t) => {
    if (t.includes("FROM audit_events a")) return rows;
    if (t.includes("UPDATE agreements")) return updated;
    return undefined;
  });

test("完了は締結、辞退は解約に対応させる", () => {
  assert.equal(mapCloudSignStatus("completed"), "executed");
  assert.equal(mapCloudSignStatus("signed"), "executed");
  assert.equal(mapCloudSignStatus("declined"), "terminated");
  assert.equal(mapCloudSignStatus("canceled"), "terminated");
});

test("途中経過では合意を動かさない", () => {
  assert.equal(mapCloudSignStatus("sent"), null);
  assert.equal(mapCloudSignStatus("viewed"), null);
  assert.equal(mapCloudSignStatus(""), null);
});

test("署名完了で動かすのは合意であって文書ではない", async () => {
  const db = build([sent()]);
  const r = await handleCloudSign(db, { externalId: "cs-1", payload: { status: "completed" } });

  assert.equal(r.applied, true);
  assert.equal(r.detail.agreementId, 4);
  assert.ok(db.queries.some((q) => q.text.includes("UPDATE agreements")));
  assert.ok(!db.queries.some((q) => /UPDATE documents/i.test(q.text)),
    "文書は出力物。署名されたのは合意そのもの");
});

test("途中経過は記録するが何も動かさない", async () => {
  const db = build([sent()]);
  const r = await handleCloudSign(db, { externalId: "cs-1", payload: { status: "sent" } });
  assert.equal(r.applied, false);
  assert.match(String(r.detail.reason), /途中経過/);
  assert.ok(!db.queries.some((q) => q.text.includes("UPDATE agreements")));
});

test("送った覚えのない外部IDは黙って捨てず、理由を残す", async () => {
  const db = build([]);
  const r = await handleCloudSign(db, { externalId: "unknown", payload: { status: "completed" } });
  assert.equal(r.applied, false);
  assert.match(String(r.detail.reason), /見つからない/);
  assert.equal(r.detail.documentRef, "unknown");
});

test("合意に紐づかない文書は状態を動かせない", async () => {
  const db = build([sent({ agreement_id: null })]);
  const r = await handleCloudSign(db, { externalId: "cs-1", payload: { status: "completed" } });
  assert.equal(r.applied, false);
  assert.match(String(r.detail.reason), /合意に紐づいていない/);
  assert.equal(r.detail.documentNo, "ARC-LIC-2026-0003");
});

test("すでにその状態なら二度書かない", async () => {
  const db = build([sent()], []);   // UPDATE が0行
  const r = await handleCloudSign(db, { externalId: "cs-1", payload: { status: "completed" } });
  assert.equal(r.applied, false);
  assert.match(String(r.detail.reason), /すでにその状態/);
});

test("文書IDは payload の別名でも読む", async () => {
  const db = build([sent()]);
  await handleCloudSign(db, { externalId: "x", payload: { documentID: "cs-9", status: "completed" } });
  assert.equal(db.find("FROM audit_events a")!.params[0], "cs-9");
});

test("対象外の source は反映せず、監査も増やさない", async () => {
  const db = new FakeDatabase();
  const r = await applyInbound(db, { source: "slack", externalId: "e", payload: {} });
  assert.equal(r.applied, false);
  assert.match(String(r.detail.reason), /反映の対象外/);
  assert.equal(db.find("INSERT INTO audit_events"), undefined,
    "受信そのものは .receive で記録済み。二重に残さない");
});

test("反映した事実を監査に残す", async () => {
  const db = build([sent()]);
  await applyInbound(db, { source: "cloudsign", externalId: "cs-1", payload: { status: "completed" } });
  const audit = db.find("INSERT INTO audit_events")!;
  assert.equal(audit.params[1], "cloudsign.applied");
  const detail = JSON.parse(String(audit.params[5]));
  assert.equal(detail.applied, true);
  assert.equal(detail.agreementId, 4);
});
