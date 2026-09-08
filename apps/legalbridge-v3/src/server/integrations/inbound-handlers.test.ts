import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import {
  applyInbound, backlogIssueKey, handleBacklog, handleCloudSign, isBacklogClosed,
  mapCloudSignStatus
} from "./inbound-handlers.js";

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

// ---- Backlog ----

const backlogDb = (linked: any[] = [{ link_id: 5, id: 8, matter_no: "MTR-2026-00008", status: "open" }]) =>
  new FakeDatabase((t) => {
    if (t.includes("FROM matter_links l JOIN matters m")) return linked;
    return undefined;
  });

const issue = (statusId: number, statusName: string) => ({
  project: { projectKey: "LEGAL" },
  content: { key_id: 12, summary: "契約書レビュー", status: { id: statusId, name: statusName } }
});

test("課題キーはプロジェクトキーと番号から組み立てる", () => {
  assert.equal(backlogIssueKey(issue(1, "未対応")), "LEGAL-12");
  assert.equal(backlogIssueKey({ issueKey: "LEGAL-99" }), "LEGAL-99");
  assert.equal(backlogIssueKey({}), "");
});

test("閉じたと見なすのは完了だけ。処理済みは担当者が終えただけ", () => {
  assert.equal(isBacklogClosed("完了", 4), true);
  assert.equal(isBacklogClosed("処理済み", 3), false);
  assert.equal(isBacklogClosed("処理中", 2), false);
  // 状態を作り替えている場合は名前で見る。
  assert.equal(isBacklogClosed("Closed"), true);
  assert.equal(isBacklogClosed("レビュー中"), false);
});

test("紐づけの綴りは backlog_issue（制約が通す値）", async () => {
  const db = backlogDb();
  await handleBacklog(db, { externalId: "e", payload: issue(2, "処理中") });
  const q = db.find("FROM matter_links l JOIN matters m")!;
  assert.match(q.text, /target_type = 'backlog_issue'/);
  assert.equal(q.params[0], "LEGAL-12");
});

test("Backlog の状態は写すが、案件の状態は動かさない", async () => {
  const db = backlogDb();
  const r = await handleBacklog(db, { externalId: "e", payload: issue(2, "処理中") });

  assert.equal(r.applied, true);
  assert.ok(db.find("UPDATE matter_links"), "紐づけに写す");
  assert.equal(db.find("UPDATE matters"), undefined, "案件は人が判断する");
});

test("課題が完了で案件が開いたままなら、突き合わせの課題を残す", async () => {
  const db = backlogDb();
  await handleBacklog(db, { externalId: "e", payload: issue(4, "完了") });
  const dq = db.find("INSERT INTO data_quality_issues")!;
  assert.match(dq.text, /BACKLOG_CLOSED_MATTER_OPEN/);
  assert.equal(dq.params[0], 8);
});

test("案件を閉じたのに課題が動いていたら逆向きの課題を残す", async () => {
  const db = backlogDb([{ link_id: 5, id: 8, matter_no: "MTR-2026-00008", status: "done" }]);
  await handleBacklog(db, { externalId: "e", payload: issue(2, "処理中") });
  assert.match(db.find("INSERT INTO data_quality_issues")!.text, /BACKLOG_OPEN_MATTER_CLOSED/);
});

test("食い違いが解ければ課題を閉じる。開きっぱなしにしない", async () => {
  const db = backlogDb([{ link_id: 5, id: 8, matter_no: "MTR-2026-00008", status: "done" }]);
  await handleBacklog(db, { externalId: "e", payload: issue(4, "完了") });
  assert.equal(db.find("INSERT INTO data_quality_issues"), undefined);
  assert.match(db.find("UPDATE data_quality_issues")!.text, /status = 'resolved'/);
});

test("紐づく案件が無ければ何もしない（Backlog 全体を取り込まない）", async () => {
  const db = backlogDb([]);
  const r = await handleBacklog(db, { externalId: "e", payload: issue(4, "完了") });
  assert.equal(r.applied, false);
  assert.match(String(r.detail.reason), /紐づく案件が無い/);
  assert.equal(db.find("UPDATE matter_links"), undefined);
});
