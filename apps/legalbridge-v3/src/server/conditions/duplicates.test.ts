import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { ConditionDuplicateService, decide, fingerprintOf, type DuplicateGroup } from "./duplicates.js";

const cond = (over: Record<string, unknown> = {}) => ({
  id: 1, condition_no: "CL-1", name: "挿絵 制作委託", status: "active",
  created_at: "2026-06-01T00:00:00Z", kind: "service", pricing_model: "fixed",
  amount: 35000, rate_ppm: null, term_start: null, term_end: null,
  counterparty_id: 3, party_name: "受託者名", work_id: 10, work_title: "星降る夜のミュゼ",
  events: 0, documents: 0, payments: 0, schedules: 0, children: 0, ...over
});

const db = (rows: Array<Record<string, unknown>>) => new FakeDatabase((t) => {
  if (t.includes("FROM matters WHERE id")) {
    return [{ id: 1, matter_no: "RR241", title: "テストプレイヤーの発注" }];
  }
  if (t.includes("FROM conditions c")) return rows;
  return [];
});

// ---------------------------------------------------------------------------
// 指紋
// ---------------------------------------------------------------------------

test("相手先が違えば別物（明細が同じでも4人ぶんの別の取引）", () => {
  assert.notEqual(fingerprintOf(cond()), fingerprintOf(cond({ counterparty_id: 4 })));
});

test("作品・種別・計算方式・金額・料率・期間・名前のどれが違っても別物", () => {
  const base = fingerprintOf(cond());
  for (const over of [{ work_id: 11 }, { kind: "expense" }, { pricing_model: "subscription" },
                      { amount: 35001 }, { rate_ppm: 100000 },
                      { term_start: "2026-04-01" }, { term_end: "2027-03-31" },
                      { name: "挿絵 制作委託（第2期）" }]) {
    assert.notEqual(fingerprintOf(cond(over)), base, JSON.stringify(over));
  }
});

test("同じ内容なら同じ指紋（番号と作成日は見ない）", () => {
  assert.equal(fingerprintOf(cond({ id: 2, condition_no: "CL-2" })), fingerprintOf(cond()));
  // 名前の前後の空白は揃える。
  assert.equal(fingerprintOf(cond({ name: " 挿絵 制作委託 " })), fingerprintOf(cond()));
});

// ---------------------------------------------------------------------------
// どれを残すか
// ---------------------------------------------------------------------------

const member = (id: number, over: Record<string, number> = {}) => ({
  id, conditionNo: `CL-${id}`, name: "挿絵", status: "active", createdAt: null,
  carries: { events: 0, documents: 0, payments: 0, schedules: 0, children: 0, ...over },
  hasRecords: (over.events ?? 0) + (over.documents ?? 0) + (over.payments ?? 0) > 0,
  blocked: (over.events ?? 0) + (over.documents ?? 0) + (over.payments ?? 0) + (over.children ?? 0)
    ? "ぶら下がっています" : null
});

const group = (members: ReturnType<typeof member>[]): DuplicateGroup => ({
  key: "k", partyName: "受託者名", workTitle: null, name: "挿絵", kind: "service",
  pricingModel: "fixed", amount: 35000, termStart: null, termEnd: null,
  members, keepId: null, voidIds: [], verdict: "undecidable", note: ""
});

test("中身を持つのが1本なら、それを残して空の残りを畳む", () => {
  const d = decide(group([member(1, { events: 2, documents: 1 }), member(2), member(3)]));
  assert.equal(d.verdict, "keep_one");
  assert.equal(d.keepId, 1);
  assert.deepEqual(d.voidIds, [2, 3]);
});

test("2本以上が中身を持っていたら決めない（本物の紙を消した教訓）", () => {
  const d = decide(group([member(1, { events: 2 }), member(2, { documents: 1 }), member(3)]));
  assert.equal(d.verdict, "undecidable");
  assert.equal(d.keepId, null);
  // 畳める候補を1本も出さない。人が中身を見るまで何もしない。
  assert.deepEqual(d.voidIds, []);
  assert.match(d.note, /別々の取引だったことがある/);
});

test("派生条件がぶら下がっていても「中身を持つ」に数える", () => {
  const d = decide(group([member(1, { children: 1 }), member(2, { events: 1 })]));
  assert.equal(d.verdict, "undecidable");
});

test("全部空なら、いちばん古い1本を残す案にする", () => {
  const d = decide(group([member(5), member(2), member(9)]));
  assert.equal(d.verdict, "all_empty");
  assert.equal(d.keepId, 2);
  assert.deepEqual(d.voidIds.sort(), [5, 9]);
  assert.match(d.note, /選び直せます/);
});

// ---------------------------------------------------------------------------
// 読み取り
// ---------------------------------------------------------------------------

test("1本しかないものは重複として出さない", async () => {
  const view = await new ConditionDuplicateService(db([cond(), cond({ id: 2, amount: 50000 })]))
    .forMatter(1);
  assert.deepEqual(view.groups, []);
  assert.equal(view.summary.groups, 0);
});

test("同じ内容が2本あれば束にして、何を抱えているかを出す", async () => {
  const view = await new ConditionDuplicateService(db([
    cond({ id: 1, condition_no: "CL-1", events: 2, documents: 1, payments: 1 }),
    cond({ id: 2, condition_no: "CL-2" })
  ])).forMatter(1);
  assert.equal(view.groups.length, 1);
  assert.equal(view.summary.conditions, 2);
  assert.equal(view.summary.voidable, 1);
  const [keep, drop] = view.groups[0]!.members;
  assert.equal(keep?.hasRecords, true);
  assert.match(keep?.blocked ?? "", /実績 2 件・文書 1 枚・支払 1 件/);
  assert.equal(drop?.blocked, null);
  assert.equal(view.groups[0]?.keepId, 1);
  assert.deepEqual(view.groups[0]?.voidIds, [2]);
});

test("決められない束を先に出す", async () => {
  const view = await new ConditionDuplicateService(db([
    cond({ id: 1, party_name: "あ", events: 1 }),
    cond({ id: 2, party_name: "あ" }),
    cond({ id: 3, counterparty_id: 9, party_name: "い", events: 1 }),
    cond({ id: 4, counterparty_id: 9, party_name: "い", documents: 1 })
  ])).forMatter(1);
  assert.equal(view.groups.length, 2);
  assert.equal(view.groups[0]?.verdict, "undecidable");
  assert.equal(view.summary.undecidable, 1);
});

/** 無効化そのものは write-service の仕事。ここでは「呼ばれたか」だけを見る。 */
const stubWrites = (voided: number[]) => ({
  async void(id: number) { voided.push(id); return { changed: [], resolvesThrough: {} }; }
} as unknown as ConstructorParameters<typeof ConditionDuplicateService>[1]);

test("中身を抱えた条件は畳まない（紙が無効な条件を指したまま残る）", async () => {
  const database = db([
    cond({ id: 1, condition_no: "CL-1", events: 2 }),
    cond({ id: 2, condition_no: "CL-2" })
  ]);
  const voided: number[] = [];
  const r = await new ConditionDuplicateService(database, stubWrites(voided))
    .voidAll(1, [1, 2], "重複のため", "who");
  // 中身のある 1 には手を出していない。
  assert.deepEqual(voided, [2]);
  assert.equal(r.ok, 1);
  assert.equal(r.failed, 1);
  assert.equal(r.outcomes.find((o) => o.id === 1)?.ok, false);
  assert.match(r.outcomes.find((o) => o.id === 1)?.error ?? "", /先に紙と支払を畳んでください/);
  assert.equal(r.outcomes.find((o) => o.id === 2)?.ok, true);
});

test("重複でない条件は畳ませない", async () => {
  const r = await new ConditionDuplicateService(db([cond()]), stubWrites([]))
    .voidAll(1, [99], "x", "who");
  assert.equal(r.failed, 1);
  assert.match(r.outcomes[0]?.error ?? "", /重複の中にありません/);
});

test("理由なし・選択なしでは畳めない", async () => {
  const s = new ConditionDuplicateService(db([cond()]), stubWrites([]));
  await assert.rejects(() => s.voidAll(1, [1], "  ", "who"), /理由を書いて/);
  await assert.rejects(() => s.voidAll(1, [], "重複のため", "who"), /選んでください/);
});
