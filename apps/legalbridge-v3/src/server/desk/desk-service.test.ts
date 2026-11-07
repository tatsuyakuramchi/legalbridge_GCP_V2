import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { DeskService, whenOf, type TodayTools } from "./desk-service.js";

// 2026-11-05 10:00（東京）
const NOW = () => new Date("2026-11-05T01:00:00Z");

const intakeRow = (id: number, over: Partial<Awaited<ReturnType<TodayTools["intake"]["list"]>>[number]> = {}) => ({
  id, requestNo: `REQ-${id}`, title: `依頼 ${id}`, counterpartyName: "ノースライト企画", counterpartyId: 7,
  requesterName: "田中", dueOn: null, createdAt: "2026-11-05T00:00:00Z", matterId: null, hasUnseenUpdate: false, ...over
});

const tools = (over: Partial<TodayTools> = {}, calls: string[] = []): TodayTools => ({
  intake: { list: async (tab) => { calls.push(`intake:${tab}`); return tab === "new" ? [intakeRow(1), intakeRow(2, { matterId: 30 })] : [intakeRow(2, { matterId: 30, hasUnseenUpdate: true })]; } },
  tasks: { list: async (_tab, assignee) => { calls.push(`tasks:${assignee}`); return [
    { id: 11, title: "原作者へ連絡", dueOn: "2026-11-07", purposeLabel: "その他", request: { requestNo: "REQ-9", counterpartyName: null } }
  ]; } },
  deadlines: { deadlines: async (days) => { calls.push(`deadlines:${days}`); return [
    { source: "agreement", refId: 44, refNo: "K-0044", title: "ライセンス基本契約", dueOn: "2026-11-04", status: "executed", overdue: true },
    { source: "matter", refId: 30, refNo: "MTR-30", title: "星海のアトラス", dueOn: "2026-11-20", status: "open", overdue: false },
    { source: "task", refId: 11, refNo: "MTR-30", title: "原作者へ連絡", dueOn: "2026-11-07", status: "todo", overdue: false }
  ]; } },
  ...over
});

test("期日の区分：期限切れ・今日・7 日以内・それ以降・なし", () => {
  assert.equal(whenOf("2026-11-04", "2026-11-05"), "over");
  assert.equal(whenOf("2026-11-05", "2026-11-05"), "today");
  assert.equal(whenOf("2026-11-12", "2026-11-05"), "week");
  assert.equal(whenOf("2026-11-13", "2026-11-05"), "later");
  assert.equal(whenOf(null, "2026-11-05"), "none");
});

test("今日やること：受付箱・自分のタスク・期限を 1 本の並びにする", async () => {
  const calls: string[] = [];
  const r = await new DeskService(new FakeDatabase(), tools({}, calls), NOW).today(5);
  assert.deepEqual(calls, ["intake:new", "intake:updated", "tasks:5", "deadlines:14"], "並べて投げず、順に読む");
  assert.deepEqual(r.items.map((x) => x.key), [
    "deadline:agreement:44", // 期限切れが先頭
    "intake:1", "intake:2",  // 受付箱は期日が無くても今日
    "task:11",               // 今週
    "deadline:matter:30"     // それ以降
  ]);
  assert.equal(r.items.filter((x) => x.key.startsWith("intake:2")).length, 1, "新規と更新ありの重複は 1 つ");
  assert.equal(r.items.find((x) => x.key === "intake:2")!.updated, true);
  assert.ok(!r.items.some((x) => x.key === "deadline:task:11"), "作業の期限はタスクと重ねない");
  assert.deepEqual(r.items.find((x) => x.key === "intake:1")!.desk, { root: "party", id: 7 });
  assert.deepEqual(r.items.find((x) => x.key === "intake:2")!.desk, { root: "matter", id: 30 });
  assert.deepEqual(r.counts, { over: 1, today: 2, week: 1, total: 5 });
});

test("今日やること：1 分は覚えておき、担当ごとに分ける", async () => {
  const calls: string[] = [];
  const desk = new DeskService(new FakeDatabase(), tools({}, calls), NOW);
  await desk.today(5);
  await desk.today(5);
  assert.equal(calls.filter((c) => c === "tasks:5").length, 1, "2 回目は覚えた結果");
  await desk.today(6);
  assert.equal(calls.filter((c) => c === "tasks:6").length, 1, "担当が違えば別に数える");
});

test("今日やること：同時に来た要求は 1 回の計算に相乗りする", async () => {
  const calls: string[] = [];
  const desk = new DeskService(new FakeDatabase(), tools({}, calls), NOW);
  await Promise.all([desk.today(null), desk.today(null), desk.today(null)]);
  assert.equal(calls.filter((c) => c === "tasks:null").length, 1);
});

test("今日やること：道具が 1 つ落ちても残りは出る", async () => {
  const r = await new DeskService(new FakeDatabase(), tools({
    deadlines: { deadlines: async () => { throw new Error("down"); } }
  }), NOW).today(null);
  assert.deepEqual(r.items.map((x) => x.kind), ["intake", "intake", "task"]);
});

test("ツリーの一段目：検索語が無いときは 1 分覚え、検索語は % をそのまま探す", async () => {
  const db = new FakeDatabase((t) => t.includes("FROM conditions c JOIN parties p")
    ? [{ id: 7, name: "ノースライト企画", party_code: "P-7", n: 4 }] : undefined);
  const desk = new DeskService(db, tools(), NOW);
  const a = await desk.roots("party", null);
  await desk.roots("party", "  ");
  assert.equal(db.all("JOIN parties p").length, 1, "空の検索語は検索語なしと同じ");
  assert.deepEqual(a[0], { key: "party:7", kind: "party", id: 7, label: "ノースライト企画", sub: "P-7", count: 4, expandable: true });
  await desk.roots("party", "50%_off");
  const q = db.all("JOIN parties p").at(-1)!;
  assert.equal(q.params[0], "%50\\%\\_off%");
});

test("ツリーの一段目：案件は終わっていないものだけ、作品は利用許諾の本数を添える", async () => {
  const db = new FakeDatabase((t) => {
    if (t.includes("FROM matters m")) return [{ id: 30, matter_no: "MTR-30", title: "星海のアトラス", due_on: "2026-11-20", n: 5 }];
    if (t.includes("JOIN works w")) return [{ id: 3, work_code: "WRK-3", title: "星海のアトラス", n: 6, licenses: 2, category: "game" }];
    return undefined;
  });
  const desk = new DeskService(db, tools(), NOW);
  const m = await desk.roots("matter", null);
  assert.ok(db.find("FROM matters m")!.text.includes("NOT IN ('done', 'canceled')"));
  assert.deepEqual([m[0]!.label, m[0]!.sub, m[0]!.count], ["星海のアトラス", "MTR-30 ・ 期日 2026-11-20", 5]);
  const w = await desk.roots("work", null);
  assert.deepEqual([w[0]!.sub, w[0]!.count, w[0]!.category], ["WRK-3 ・ ボードゲーム等 ・ 利用許諾 2 本", 6, "game"]);
});

test("ツリーの一段目：作品はカテゴリで絞れ、カテゴリごとに別に覚える（ほかの切り口ではカテゴリを無視）", async () => {
  const db = new FakeDatabase((t) => t.includes("JOIN works w")
    ? [{ id: 4, work_code: "W-4", title: "灯台の書", n: 2, licenses: 1, category: "publishing" }] : undefined);
  const desk = new DeskService(db, tools(), NOW);
  const all = await desk.roots("work", null);
  const pub = await desk.roots("work", null, "publishing");
  await desk.roots("work", null, "publishing");
  await desk.roots("work", null, "game");
  const works = db.all("JOIN works w");
  assert.equal(works.length, 3, "すべて・出版・ボードゲーム等で 3 回、同じカテゴリは覚えた結果");
  assert.deepEqual(works.map((q) => q.params[2]), [null, "publishing", "game"]);
  assert.ok(works[0]!.text.includes("HAVING $3::text IS NULL"));
  assert.ok(works[0]!.text.includes("w.source_title ILIKE $1"), "原作名でも探せる");
  assert.equal(all[0]!.sub, "W-4 ・ 出版 ・ 利用許諾 1 本");
  assert.equal(pub[0]!.category, "publishing");
  await desk.roots("party", null, "game");
  assert.equal(db.all("JOIN parties p").length, 1);
});

test("取引先の下：契約（補助文書は親に数える）と、どの契約にも紐づかない条件", async () => {
  const db = new FakeDatabase((t) => {
    if (t.includes("WITH tops AS")) return [
      { id: 31, agreement_no: "K-0031", title: "業務委託基本契約", kind: "master", status: "executed", direction: "in", expires_on: null, ids: [31, 35], n: 4 },
      { id: 44, agreement_no: "K-0044", title: "ライセンス基本契約", kind: "master", status: "executed", direction: "in", expires_on: "2027-01-09", ids: [44], n: 0 }
    ];
    if (t.includes("c.agreement_id IS NULL OR")) return [{ n: 2 }];
    return undefined;
  });
  const nodes = await new DeskService(db, tools(), NOW).partyChildren(7);
  assert.deepEqual(nodes.map((n) => [n.key, n.count]), [["agreement:31", 4], ["agreement:44", 0], ["loose:7", 2]]);
  assert.deepEqual(nodes[0]!.agreementIds, [31, 35]);
  assert.equal(nodes[1]!.sub, "基本契約 ・ IN ・ 締結済 ・ 満了 2027-01-09");
  assert.deepEqual(db.find("c.agreement_id IS NULL OR")!.params, [7, [31, 35, 44]]);
});

test("取引先の下：紐づかない条件が無ければその行を出さない", async () => {
  const db = new FakeDatabase((t) => t.includes("c.agreement_id IS NULL OR") ? [{ n: 0 }] : undefined);
  assert.deepEqual(await new DeskService(db, tools(), NOW).partyChildren(7), []);
});
