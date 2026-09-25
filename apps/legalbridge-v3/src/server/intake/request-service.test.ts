import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { MemoryAdapter } from "../integrations/adapters.js";
import { DispatchService } from "../integrations/dispatch-service.js";
import type { IntegrationMode } from "../integrations/gate.js";
import {
  IntakeRequestService, requestIssueDescription, requestIssueSummary, submitAcknowledgement
} from "./request-service.js";
import type { IntakeSubmission } from "../integrations/slack-intake.js";

const submission: IntakeSubmission = {
  kind: "outsourcing", title: "追加アートワーク発注", counterpartyName: "株式会社甲",
  dueOn: "2026-10-09", detail: "第2弾 8点", requesterSlackId: "U123", requesterName: "yamamoto"
};

interface Row { [k: string]: any }
const build = (state: { row?: Row; parties?: Row[]; matter?: Row; otherLink?: Row } = {}) => new FakeDatabase((t) => {
  if (t.includes("SELECT 1 FROM document_sequences")) return [{ x: 1 }];
  if (t.includes("UPDATE document_sequences")) return [{ current_value: 12 }];
  if (t.includes("FROM intake_requests WHERE request_no")) return [];
  if (t.includes("FROM matters WHERE matter_no")) return [];
  if (t.includes("INSERT INTO intake_requests")) return [{ id: 7, request_no: "REQ-2026-00012" }];
  if (t.includes("SELECT * FROM intake_requests WHERE id = $1 FOR UPDATE")) return state.row ? [state.row] : [];
  if (t.includes("JOIN v_party_resolved")) return state.parties ?? [];
  if (t.includes("INSERT INTO matters")) return [{ id: 42, matter_no: "MTR-2026-00220" }];
  if (t.includes("FROM matters WHERE id = $1")) return state.matter ? [state.matter] : [];
  if (t.includes("l.target_ref = $1 AND l.matter_id <> $2")) return state.otherLink ? [state.otherLink] : [];
  if (t.includes("LEFT JOIN staff s ON s.id = m.owner_staff_id")) return [{ name: "佐藤" }];
  if (t.includes("FROM intake_requests r LEFT JOIN matters m")) {
    return [{ id: 3, request_no: "REQ-2026-00003", matter_id: 42, matter_no: "MTR-2026-00220" }];
  }
  return undefined;
});

const service = (d: FakeDatabase, modes: Partial<Record<string, IntegrationMode>> = {}) => {
  const slack = new MemoryAdapter("slack");
  const backlog = new MemoryAdapter("backlog");
  const dispatch = new DispatchService(d, { slack, backlog }, (channel) => ({
    mode: modes[channel] ?? "off", adapterConfigured: true, readOnly: false, allowlist: []
  }));
  return { svc: new IntakeRequestService(d, dispatch, { backlogIssueTypeId: "555" }), slack, backlog };
};

const open = (over: Row = {}): Row => ({
  id: 7, request_no: "REQ-2026-00012", state: "new", title: "追加アートワーク発注",
  detail: "第2弾 8点", counterparty_name: "株式会社甲", due_on: new Date(2026, 9, 9),
  requester_slack_id: "U123", backlog_issue_key: "LEGAL-9001", ...over
});

// ---- Slack の送信 ----

test("Slack の送信は案件を立てず、受付箱に入れる", async () => {
  const d = build();
  const { svc } = service(d);
  const r = await svc.submitFromSlack(submission);
  assert.equal(r.requestNo, "REQ-2026-00012");
  const ins = d.find("INSERT INTO intake_requests")!;
  assert.match(ins.text, /'slack', 'new'/);
  assert.equal(d.find("INSERT INTO matters"), undefined, "受け付けるまで案件は立てない");
});

test("登録だけなら外へは送らない（Slack の 3 秒以内の応答のため、送信は後に回す）", async () => {
  const d = build();
  const { svc, backlog, slack } = service(d, { backlog: "live", slack: "live" });
  const r = await svc.registerFromSlack(submission);
  assert.deepEqual(r, { requestId: 7, requestNo: "REQ-2026-00012" });
  assert.equal(backlog.sent.length + slack.sent.length, 0);
  const done = await svc.followUpSlack(r, submission);
  assert.equal(done.issueKey, "backlog-1");
  assert.equal(slack.sent.length, 1);
});

test("Backlog に起案し、課題キーを控える。件名の頭に依頼番号", async () => {
  const d = build();
  const { svc, backlog } = service(d, { backlog: "live" });
  const r = await svc.submitFromSlack(submission);
  assert.equal(backlog.sent.length, 1);
  assert.equal(backlog.sent[0].subject, "[REQ-2026-00012] 追加アートワーク発注");
  assert.equal(backlog.sent[0].recipient, "555", "課題種別IDを宛先として渡す");
  assert.equal(r.issueKey, "backlog-1");
  const upd = d.find("SET backlog_issue_key = $2")!;
  assert.deepEqual(upd.params, [7, "backlog-1"]);
});

test("Backlog がゲートで止まっても受付箱には入る。理由を返す", async () => {
  const d = build();
  const { svc, backlog } = service(d, { backlog: "off" });
  const r = await svc.submitFromSlack(submission);
  assert.equal(backlog.sent.length, 0);
  assert.equal(r.issueKey, null);
  assert.match(r.backlogReason!, /無効/);
  assert.ok(d.find("INSERT INTO intake_requests"));
});

test("依頼者に送信の確認を Slack で返す（ゲートが開いているとき）", async () => {
  const d = build();
  const { svc, slack } = service(d, { slack: "live" });
  await svc.submitFromSlack(submission);
  assert.equal(slack.sent[0].recipient, "U123");
  assert.match(slack.sent[0].body, /REQ-2026-00012/);
  assert.match(slack.sent[0].body, /受け付けたら Slack でお知らせします/);
});

test("課題の本文には依頼者のメンションと、ステータスを更新しない旨を書く", () => {
  const body = requestIssueDescription({ requestNo: "REQ-2026-00012", submission });
  assert.match(body, /<@U123>/);
  assert.match(body, /この課題のステータスは更新されません/);
  assert.equal(requestIssueSummary(null, "件名"), "件名");
  assert.match(submitAcknowledgement({ requestNo: "REQ-2026-00012", issueKey: "LEGAL-1", submission }), /LEGAL-1/);
});

// ---- 受け付ける ----

test("新規案件で受付: 案件を立て、課題を案件に繋ぎ、依頼を受付済にする", async () => {
  const d = build({ row: open(), parties: [{ id: 5, name: "株式会社甲" }] });
  const { svc, slack } = service(d, { slack: "live" });
  const r = await svc.accept(7, { mode: "new", kind: "outsourcing", ownerStaffId: 3 }, "legal@x");
  assert.deepEqual([r.matterId, r.matterNo, r.createdMatter, r.notified], [42, "MTR-2026-00220", true, true]);
  const m = d.find("INSERT INTO matters")!;
  assert.equal(m.params[3], 5, "相手先は1件に決まれば紐づける");
  assert.equal(m.params[5], "2026-10-09", "期日は依頼のものを引き継ぐ");
  assert.equal(m.params[8], 3, "担当");
  const link = d.find("INSERT INTO matter_links")!;
  assert.deepEqual([link.params[0], link.params[1]], [42, "LEGAL-9001"]);
  assert.match(link.text, /'origin'/);
  const upd = d.find("SET state = 'accepted'")!;
  assert.equal(upd.params[1], 42);
  assert.match(slack.sent[0].body, /MTR-2026-00220/);
  assert.match(slack.sent[0].body, /担当：佐藤/);
});

test("既存の案件へ接続: 案件は立てない", async () => {
  const d = build({ row: open(), matter: { id: 40, matter_no: "MTR-2026-00100", title: "既存", status: "open" } });
  const { svc } = service(d);
  const r = await svc.accept(7, { mode: "existing", matterId: 40, kind: "outsourcing" }, "legal@x");
  assert.equal(r.createdMatter, false);
  assert.equal(d.find("INSERT INTO matters"), undefined);
  assert.equal(d.find("SET state = 'accepted'")!.params[1], 40);
});

test("統合済みの案件には繋げない", async () => {
  const d = build({ row: open(), matter: { id: 40, matter_no: "MTR-2026-00100", title: "旧", merged_into_id: 41 } });
  await assert.rejects(service(d).svc.accept(7, { mode: "existing", matterId: 40, kind: "single" }, "x"),
    /統合済み/);
});

test("課題が別の案件に繋がっていれば止める（受信の行き先が決まらなくなる）", async () => {
  const d = build({ row: open(), matter: { id: 40, matter_no: "MTR-2026-00100", title: "既存" },
                    otherLink: { matter_id: 39, matter_no: "MTR-2026-00099" } });
  await assert.rejects(service(d).svc.accept(7, { mode: "existing", matterId: 40, kind: "single" }, "x"),
    /MTR-2026-00099 に繋がっています/);
});

test("処理済みの依頼は受け付けない", async () => {
  const d = build({ row: open({ state: "accepted", matter_id: 42 }) });
  await assert.rejects(service(d).svc.accept(7, { mode: "new", kind: "single" }, "x"), /処理済み/);
});

// ---- 保留・対象外・重複・戻す ----

test("保留は理由が必須。確認したいことを依頼者に送る", async () => {
  const d = build({ row: open() });
  const { svc, slack } = service(d, { slack: "live" });
  await assert.rejects(svc.hold(7, "  ", null, "x"), /理由/);
  await svc.hold(7, "先方書式か当社書式か", "2026-09-30", "x");
  const upd = d.find("SET state = 'on_hold'")!;
  assert.deepEqual(upd.params.slice(1, 3), ["先方書式か当社書式か", "2026-09-30"]);
  assert.match(slack.sent[0].body, /先方書式か当社書式か/);
});

test("対象外: テスト投稿・誤起票は依頼者に知らせない", async () => {
  const d = build({ row: open() });
  const { svc, slack } = service(d, { slack: "live" });
  const r = await svc.dismiss(7, "テスト投稿", "x");
  assert.equal(r.notified, false);
  assert.equal(slack.sent.length, 0);
  assert.ok(d.find("SET state = 'dismissed'"));
});

test("重複: 重複元の案件を引き継ぐ", async () => {
  const d = build({ row: open() });
  await service(d).svc.duplicate(7, 3, "x");
  const upd = d.find("SET state = 'duplicate'")!;
  assert.deepEqual(upd.params.slice(0, 3), [7, 3, 42]);
});

test("受付済みは受付箱に戻せない（案件が動いている）", async () => {
  const d = new FakeDatabase((t) =>
    t.includes("SELECT state FROM intake_requests") ? [{ state: "accepted" }] : undefined);
  await assert.rejects(service(d).svc.reopen(7, "x"), /戻せません/);
});
