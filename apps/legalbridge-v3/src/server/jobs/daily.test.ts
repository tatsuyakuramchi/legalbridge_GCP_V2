import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { DailyJob, formatBody, type DailyFinding } from "./daily.js";
import { DispatchService } from "../integrations/dispatch-service.js";
import { MemoryAdapter } from "../integrations/adapters.js";

const agreement = (days: number) => ({
  id: 1, agreement_no: "AGR-1", title: "基本契約", expires_on: new Date(2026, 9, 1),
  auto_renewal: false, renewal_notice_months: null, party: "株式会社甲", days
});
const task = (days: number) => ({
  id: 2, title: "納品日確認", due_at: new Date(2026, 6, 28),
  matter_no: "MTR-1", matter_title: "制作委託", assignee: "山田", days
});
const payment = (days: number) => ({
  id: 3, payment_no: "PAY-1", due_on: new Date(2026, 8, 30), amount: 300000,
  currency: "JPY", status: "planned", party: "山田太郎", party_kind: "individual", days
});

const build = (opts: {
  agreements?: any[]; tasks?: any[]; payments?: any[];
  scheduled?: any[]; previous?: any[];
} = {}) =>
  new FakeDatabase((t) => {
    if (t.includes("FROM agreements a")) return opts.agreements ?? [];
    if (t.includes("FROM tasks t")) return opts.tasks ?? [];
    if (t.includes("FROM payments y")) return opts.payments ?? [];
    if (t.includes("WHERE status = 'scheduled' AND effective_from <= current_date")) {
      return opts.scheduled ?? [];
    }
    if (t.includes("AND status = 'active'\n            AND (effective_from IS NULL")) {
      return opts.previous ?? [];
    }
    return undefined;
  });

test("満了済みと満了間近を撃ち分ける", async () => {
  const r = await new DailyJob(build({ agreements: [agreement(-10), agreement(30)] })).run();
  assert.deepEqual(r.counts, { agreement_expired: 1, agreement_expiring: 1 });
});

test("期日を過ぎた未完了タスクを拾う。放置に気づけないと困る", async () => {
  const r = await new DailyJob(build({ tasks: [task(-42)] })).run();
  assert.equal(r.counts.task_overdue, 1);
  assert.equal(r.findings[0].days, -42);
  assert.equal(r.findings[0].detail.assignee, "山田");
});

test("支払は超過と間近を分ける", async () => {
  const r = await new DailyJob(build({ payments: [payment(-3), payment(5)] })).run();
  assert.deepEqual(r.counts, { payment_overdue: 1, payment_due: 1 });
});

test("何も無ければ通知しない", async () => {
  const db = build();
  const adapter = new MemoryAdapter("gmail");
  const dispatch = new DispatchService(db, { gmail: adapter },
    () => ({ mode: "live", adapterConfigured: true, readOnly: false }));
  const r = await new DailyJob(db, dispatch).run({ notifyChannel: "gmail", notifyTo: "a@x.test" });

  assert.equal(r.findings.length, 0);
  assert.equal(r.notified, false);
  assert.equal(adapter.sent.length, 0);
});

test("ゲートが off なら洗い出すが送らない。ジョブが勝手に外へ出さない", async () => {
  const db = build({ tasks: [task(-42)] });
  const adapter = new MemoryAdapter("gmail");
  const dispatch = new DispatchService(db, { gmail: adapter },
    () => ({ mode: "off", adapterConfigured: true, readOnly: false }));
  const r = await new DailyJob(db, dispatch).run({ notifyChannel: "gmail", notifyTo: "a@x.test" });

  assert.equal(r.findings.length, 1, "洗い出しはする");
  assert.equal(r.notified, false);
  assert.equal(adapter.sent.length, 0);
  assert.deepEqual(r.notifyDetail?.blockers, ["channel_off"]);
});

test("live なら送る", async () => {
  const db = build({ tasks: [task(-42)] });
  const adapter = new MemoryAdapter("gmail");
  const dispatch = new DispatchService(db, { gmail: adapter },
    () => ({ mode: "live", adapterConfigured: true, readOnly: false }));
  const r = await new DailyJob(db, dispatch).run({ notifyChannel: "gmail", notifyTo: "a@x.test" });

  assert.equal(r.notified, true);
  assert.equal(adapter.sent.length, 1);
  assert.match(adapter.sent[0].subject ?? "", /要対応 1 件/);
});

test("送り先を渡さなければ送らない", async () => {
  const db = build({ tasks: [task(-42)] });
  const adapter = new MemoryAdapter("gmail");
  const dispatch = new DispatchService(db, { gmail: adapter },
    () => ({ mode: "live", adapterConfigured: true, readOnly: false }));
  const r = await new DailyJob(db, dispatch).run({ notifyChannel: "gmail" });
  assert.equal(r.notified, false);
  assert.equal(adapter.sent.length, 0);
});

test("見つけたものを監査に残す。あとから「あの日は出ていたか」を追える", async () => {
  const db = build({ tasks: [task(-42)] });
  await new DailyJob(db).run();
  const audit = db.find("INSERT INTO audit_events")!;
  assert.equal(audit.params[1], "job.daily");
  const detail = JSON.parse(String(audit.params[5]));
  assert.equal(detail.counts.task_overdue, 1);
  assert.equal(detail.findings[0].refNo, "MTR-1");
});

test("本文は超過が古い順。放っておいた分だけ重い", () => {
  const findings: DailyFinding[] = [
    { kind: "task_overdue", refType: "matter", refId: 1, refNo: "MTR-1", title: "新しい遅れ",
      dueOn: "2026-09-01", days: -7, detail: {} },
    { kind: "task_overdue", refType: "matter", refId: 2, refNo: "MTR-2", title: "古い遅れ",
      dueOn: "2026-07-20", days: -50, detail: {} }
  ];
  const body = formatBody(findings, "2026-09-08");
  assert.ok(body.indexOf("古い遅れ") < body.indexOf("新しい遅れ"));
  assert.match(body, /50日超過/);
});

// ---- 予約された改訂の適用 ----

const pending = () => ({
  id: 77, condition_no: "CL-2026-00042-R2", series_id: 5, effective_from: new Date(2027, 3, 1)
});

test("適用開始日が来た改訂を効かせ、前の版を差し替え済みにする", async () => {
  const db = build({ scheduled: [pending()], previous: [{ id: 5 }] });
  const r = await new DailyJob(db).run();

  const supersede = db.find("SET status = 'superseded'")!;
  assert.deepEqual(supersede.params, [5, 77], "前の版を新しい版で差し替える");
  assert.ok(db.find("SET status = 'active'"), "予約の版を効かせる");
  assert.equal(r.applied.length, 1);
  assert.equal(r.applied[0].conditionNo, "CL-2026-00042-R2");
  assert.equal(r.applied[0].supersededId, 5);
});

test("前の版が無くても効かせる（初版が予約だった場合）", async () => {
  const db = build({ scheduled: [pending()], previous: [] });
  const r = await new DailyJob(db).run();
  assert.equal(db.find("SET status = 'superseded'"), undefined);
  assert.ok(db.find("SET status = 'active'"));
  assert.equal(r.applied[0].supersededId, null);
});

test("適用日が来ていなければ何も動かさない", async () => {
  const db = build({ scheduled: [] });
  const r = await new DailyJob(db).run();
  assert.deepEqual(r.applied, []);
  assert.equal(db.find("SET status = 'active'"), undefined);
});

test("切り替えは監査に残す（人が押さずに変わるので、記録が無いと追えない）", async () => {
  const db = build({ scheduled: [pending()], previous: [{ id: 5 }] });
  await new DailyJob(db).run();
  const audit = db.all("INSERT INTO audit_events")
    .find((q) => q.params[1] === "condition.apply_revision");
  assert.ok(audit, "誰が押したわけでもない変更こそ記録が要る");
});
