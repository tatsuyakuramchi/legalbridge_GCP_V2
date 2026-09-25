import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { buildFlow, currentStep, type FlowFacts } from "./flow.js";
import { FlowNoticeJob, firedMilestones, noticeBody } from "./flow-notice.js";

const facts = (over: Partial<FlowFacts> = {}): FlowFacts => ({
  matterKind: "outsourcing", documentStyle: null, matterStatus: "open",
  conditionCount: 0, activeConditionCount: 0, conditionsWithWork: 0,
  agreementExecuted: false, agreementNo: null,
  issuedDocuments: [], draftDocuments: 0, importedDocuments: 0,
  events: {}, latestEventOn: null, statements: 0,
  payments: { total: 0, paid: 0 }, ...over
});
const flowOf = (f: FlowFacts) => { const steps = buildFlow(f); return { steps, current: currentStep(steps) }; };
const ctx = { matterNo: "MTR-2026-00001", title: "アートワーク制作", status: "open" };

// ---- 節目の判定（純関数）----

test("何も無い案件では節目は成り立たない", () => {
  assert.deepEqual(firedMilestones(flowOf(facts()), ctx), []);
});

test("発注書を決定し、納品を待つ段になったら「履行に入った」の案内まで成り立つ", () => {
  const f = facts({ agreementExecuted: true, activeConditionCount: 1,
                    issuedDocuments: [{ documentNo: "ARC-PO-2026-0001", label: "発注書" }] });
  const keys = firedMilestones(flowOf(f), ctx).map((m) => m.key);
  assert.deepEqual(keys, ["service:基本契約の確認:done", "service:発注:done", "service:納品・報告:current"]);
  const guide = firedMilestones(flowOf(f), ctx).find((m) => m.key.endsWith("納品・報告:current"))!;
  assert.match(guide.text, /\/法務依頼/);
  assert.match(guide.text, /MTR-2026-00001/, "案件番号を書いてもらえば受付箱で案件に繋がる");
});

test("相手方の文書のレビュー型は、いまの段になったら「相手方と調整中」を知らせる", () => {
  const f = facts({ documentStyle: "counterparty_review", agreementExecuted: true, activeConditionCount: 1 });
  const keys = firedMilestones(flowOf(f), ctx).map((m) => m.key);
  assert.ok(keys.includes("service:相手方の文書を確認:current"));
});

test("作品案件は制作委託と許諾で同じ名の段があるので、ブロックでキーを分ける", () => {
  const f = facts({ matterKind: "work", production: true, workId: 1, agreementExecuted: true,
                    activeConditionCount: 2, serviceConditions: 1, licenseConditions: 1,
                    issuedDocuments: [{ documentNo: "ARC-PO-2026-0001", label: "発注書" }] });
  const keys = firedMilestones(flowOf(f), ctx).map((m) => m.key);
  assert.ok(keys.includes("production:発注:done"));
  assert.ok(keys.every((k) => !k.startsWith("service:")));
});

test("案件が完了したら知らせる。文面は1案件1通にまとめる", () => {
  const fired = firedMilestones(flowOf(facts({ matterStatus: "done" })), { ...ctx, status: "done" });
  assert.ok(fired.some((f) => f.key === "matter:done"));
  const body = noticeBody(ctx, fired);
  assert.match(body.split("\n")[0], /MTR-2026-00001 アートワーク制作/);
  assert.equal(body.split("\n").filter((l) => l.startsWith("・")).length, fired.length);
});

// ---- ジョブ ----

interface State { setting?: Record<string, unknown>; marks?: Array<{ target_id: number; key: string }>; matter?: Record<string, unknown> }
const db = (state: State = {}) => new FakeDatabase((t) => {
  if (t.includes("FROM settings WHERE key")) return state.setting ? [{ value: state.setting }] : [];
  if (t.includes("FROM matters m")) {
    return [{ id: 1, matter_no: "MTR-2026-00001", title: "アートワーク制作", status: "open",
              requester_slack_id: "U1", requesters: ["U1", "U2"], has_thread: false, ...(state.matter ?? {}) }];
  }
  if (t.includes("action = 'matter.flow_notice'")) return state.marks ?? [];
  return undefined;
});
const ordered = facts({ agreementExecuted: true, activeConditionCount: 1,
                        issuedDocuments: [{ documentNo: "ARC-PO-2026-0001", label: "発注書" }] });

const job = (d: FakeDatabase, f: FlowFacts) => {
  const toMatter: string[] = [];
  const dms: Array<[string, string]> = [];
  const j = new FlowNoticeJob({
    database: d, flowOf: async () => flowOf(f),
    sendToMatter: async (_id, body) => { toMatter.push(body); return true; },
    sendDm: async (_id, slackId, body) => { dms.push([slackId, body]); return true; }
  });
  return { j, toMatter, dms };
};

test("初めて見る案件は、いまの状態を記録するだけで送らない（動かし始めた日に過去分が届かない）", async () => {
  const d = db();
  const { j, toMatter, dms } = job(d, ordered);
  const r = await j.run();
  assert.equal(r.seeded, 1);
  assert.equal(toMatter.length + dms.length, 0);
  const keys = d.all("INSERT INTO audit_events").map((q) => q.params[4]).filter(Boolean);
  assert.ok(keys.includes("flow-notice:1:_seed"));
  assert.ok(keys.includes("flow-notice:1:service:発注:done"));
});

test("前回から新しく成り立った節目だけを、案件と別の依頼者へ1通で知らせる", async () => {
  const d = db({ marks: [
    { target_id: 1, key: "_seed" }, { target_id: 1, key: "service:基本契約の確認:done" }
  ] });
  const { j, toMatter, dms } = job(d, ordered);
  const r = await j.run();
  assert.deepEqual(r.notified[0].keys, ["service:発注:done", "service:納品・報告:current"]);
  assert.equal(toMatter.length, 1, "1案件1通");
  assert.match(toMatter[0], /発注書を決定しました/);
  assert.match(toMatter[0], /履行に入りました/);
  assert.deepEqual(dms.map(([id]) => id), ["U2"], "案件の依頼者（U1）には案件宛てで届くので、DM は別の依頼者だけ");
  const keys = d.all("INSERT INTO audit_events").map((q) => q.params[4]).filter(Boolean);
  assert.ok(keys.includes("flow-notice:1:service:発注:done"), "冪等キーで二度送らない");
});

test("知らせた節目ばかりなら何も送らない", async () => {
  const d = db({ marks: [
    { target_id: 1, key: "_seed" }, { target_id: 1, key: "service:基本契約の確認:done" },
    { target_id: 1, key: "service:発注:done" }, { target_id: 1, key: "service:納品・報告:current" }
  ] });
  const { j, toMatter } = job(d, ordered);
  const r = await j.run();
  assert.equal(r.notified.length, 0);
  assert.equal(toMatter.length, 0);
});

test("settings で止められる。段ごとにも外せる", async () => {
  const stopped = await job(db({ setting: { disabled: true } }), ordered).j.run();
  assert.equal(stopped.ran, false);

  const d = db({ setting: { off: ["納品・報告"] }, marks: [{ target_id: 1, key: "_seed" }] });
  const { j, toMatter } = job(d, ordered);
  await j.run();
  assert.doesNotMatch(toMatter[0], /履行に入りました/);
});

test("1案件の失敗で残りを止めない", async () => {
  const d = db({ marks: [{ target_id: 1, key: "_seed" }] });
  const j = new FlowNoticeJob({
    database: d, flowOf: async () => { throw new Error("boom"); },
    sendToMatter: async () => true, sendDm: async () => true
  });
  const r = await j.run();
  assert.equal(r.failures.length, 1);
  assert.equal(r.ran, true);
});
