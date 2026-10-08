import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { TaskWriteService } from "./write-service.js";

/**
 * 作業テーブル（A-064）。状態の変更はデイリータスクと案件の作業で同じ経路。
 * 「案件に移す」は行を同じままに matter_id を埋め、依頼を案件へ繋ぎ直す。
 */

const task = (over: Record<string, unknown> = {}) => ({
  id: 9, matter_id: null, request_id: 7, title: "検収書 PO-1", status: "doing",
  assignee_staff_id: 3, due_at: new Date("2026-10-02T00:00:00+09:00"), ...over
});
const request = (over: Record<string, unknown> = {}) => ({
  id: 7, request_no: "REQ-2026-00012", title: "検収書 PO-1", kind: "outsourcing", detail: null,
  counterparty_id: 5, counterparty_name: "甲", requester_slack_id: "U1", due_on: null,
  backlog_issue_key: "LEGAL-9001", email_thread_id: null, source_payload: {}, ...over
});

test("完了にすると done_at が入り、戻すと消える", async () => {
  const d = new FakeDatabase((t) => (t.includes("FROM tasks WHERE id = $1 FOR UPDATE") ? [task()] : undefined));
  const svc = new TaskWriteService(d);
  const r = await svc.update(9, { status: "done" }, "legal@x");
  assert.equal(r.status, "done");
  const upd = d.find("UPDATE tasks")!;
  assert.match(upd.text, /done_at = CASE WHEN \$2 = 'done' THEN COALESCE\(done_at, now\(\)\) ELSE NULL END/);
  assert.equal(upd.params[1], "done");
  assert.equal(upd.params[3], false, "担当は触っていない");
  const audit = d.find("INSERT INTO audit_events")!;
  assert.equal(audit.params[1], "task.update");
});

test("担当と期日だけ変える（状態は据え置き）", async () => {
  const d = new FakeDatabase((t) => (t.includes("FROM tasks WHERE id = $1 FOR UPDATE") ? [task()] : undefined));
  await new TaskWriteService(d).update(9, { assigneeStaffId: null, dueOn: "2026-10-10" }, "x");
  const upd = d.find("UPDATE tasks")!;
  assert.deepEqual(upd.params.slice(1, 7), ["doing", null, true, null, true, "2026-10-10"]);
});

test("知らない状態は止める", async () => {
  await assert.rejects(new TaskWriteService(new FakeDatabase()).update(9, { status: "paused" as any }, "x"), /状態は/);
});

test("案件に移す（新規）：案件を立て、原票と条件を案件に付け、作業と依頼を案件へ", async () => {
  const d = new FakeDatabase((t) => {
    if (t.includes("FROM tasks WHERE id = $1 FOR UPDATE")) return [task()];
    if (t.includes("FROM intake_requests WHERE id = $1 FOR UPDATE")) return [request()];
    if (t.includes("SELECT 1 FROM document_sequences")) return [{ x: 1 }];
    if (t.includes("UPDATE document_sequences")) return [{ current_value: 30 }];
    if (t.includes("FROM matters WHERE matter_no")) return [];
    if (t.includes("INSERT INTO matters")) return [{ id: 42, matter_no: "MTR-2026-00230" }];
    if (t.includes("l.target_ref = $1 AND l.matter_id <> $2")) return [];
    if (t.includes("FROM intake_request_links l")) {
      return [{ target_type: "condition", target_id: 11, condition_no: "C-11", kind: "service" },
              { target_type: "document", target_id: 60, condition_no: null, kind: null }];
    }
    return undefined;
  });
  let notified: string | null = null;
  const svc = new TaskWriteService(d, async (_id, text) => { notified = text; return true; });
  const r = await svc.moveToMatter(9, { mode: "new", kind: "outsourcing" }, "legal@x");
  assert.deepEqual([r.matterId, r.matterNo, r.createdMatter, r.notified], [42, "MTR-2026-00230", true, true]);
  const m = d.find("INSERT INTO matters")!;
  assert.equal(m.params[3], 5, "相手先は依頼のもの");
  assert.equal(m.params[9], 3, "担当は作業の担当を引き継ぐ");
  const links = d.all("INSERT INTO matter_links");
  assert.ok(links.some((q) => q.text.includes("'backlog_issue'") && q.params[1] === "LEGAL-9001"));
  assert.ok(links.some((q) => q.text.includes("'condition'") && q.params[1] === "11"));
  assert.deepEqual(d.find("UPDATE documents SET matter_id")!.params, [60, 42]);
  assert.deepEqual(d.find("UPDATE tasks SET matter_id")!.params.slice(0, 2), [9, 42]);
  assert.match(d.find("SET handling = 'matter'")!.text, /matter_id = \$2/);
  assert.match(String(notified), /MTR-2026-00230/);
});

test("案件に移す（既存）：統合済みの案件には移せない。もう案件に入っている作業は移せない", async () => {
  const merged = new FakeDatabase((t) => {
    if (t.includes("FROM tasks WHERE id = $1 FOR UPDATE")) return [task()];
    if (t.includes("FROM intake_requests WHERE id = $1 FOR UPDATE")) return [request()];
    if (t.includes("FROM matters WHERE id = $1")) return [{ id: 40, matter_no: "MTR-1", merged_into_id: 41 }];
    return undefined;
  });
  await assert.rejects(new TaskWriteService(merged).moveToMatter(9, { mode: "existing", matterId: 40 }, "x"), /統合済み/);
  const already = new FakeDatabase((t) =>
    (t.includes("FROM tasks WHERE id = $1 FOR UPDATE") ? [task({ matter_id: 42 })] : undefined));
  await assert.rejects(new TaskWriteService(already).moveToMatter(9, { mode: "new" }, "x"), /もう案件に入っています/);
});

test("依頼者のメールは元の依頼に書く。形が悪ければ止める", async () => {
  const d = new FakeDatabase((t) => (t.includes("FROM tasks WHERE id = $1 FOR UPDATE") ? [task()] : undefined));
  await new TaskWriteService(d).update(9, { requesterEmail: " Tanaka@Example.co.jp " }, "x");
  assert.deepEqual(d.find("UPDATE intake_requests SET requester_email")!.params, [7, "tanaka@example.co.jp"]);
  await assert.rejects(new TaskWriteService(d).update(9, { requesterEmail: "tanaka" }, "x"), /メールの形/);
});

test("メモは tasks.description に持つ。空で消す。触らなければ据え置き", async () => {
  const d = new FakeDatabase((t) => (t.includes("FROM tasks WHERE id = $1 FOR UPDATE") ? [task()] : undefined));
  await new TaskWriteService(d).update(9, { memo: " 10/8 相手に文案を送付 " }, "x");
  const upd = d.find("UPDATE tasks")!;
  assert.match(upd.text, /description = CASE WHEN \$9::boolean THEN \$10::text ELSE description END/);
  assert.deepEqual(upd.params.slice(8, 10), [true, "10/8 相手に文案を送付"], "前後の空白は落とす");
  const cleared = new FakeDatabase((t) => (t.includes("FROM tasks WHERE id = $1 FOR UPDATE") ? [task()] : undefined));
  await new TaskWriteService(cleared).update(9, { memo: "" }, "x");
  assert.deepEqual(cleared.find("UPDATE tasks")!.params.slice(8, 10), [true, null], "空は null");
  const untouched = new FakeDatabase((t) => (t.includes("FROM tasks WHERE id = $1 FOR UPDATE") ? [task()] : undefined));
  await new TaskWriteService(untouched).update(9, { status: "doing" }, "x");
  assert.deepEqual(untouched.find("UPDATE tasks")!.params.slice(8, 10), [false, null], "メモは触らない");
});
