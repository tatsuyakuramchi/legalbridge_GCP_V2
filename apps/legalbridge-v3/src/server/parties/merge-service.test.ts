import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { PartyMergeService } from "./merge-service.js";

const party = (id: number, over: Record<string, unknown> = {}) => ({
  id, party_code: `PTY-${id}`, name: `取引先${id}`, kind: "corporate", status: "active",
  merged_into_id: null, invoice_no: null, corporate_no: null,
  conditions: 3, payments: 2, agreements: 1, matters: 1, ...over
});

const build = (rows: any[]) => new FakeDatabase((t) =>
  t.includes("FROM parties p WHERE p.id = ANY") ? rows : undefined);

test("統合前に、統合先を通して見えるようになる件数を返す", async () => {
  const r = await new PartyMergeService(build([party(1), party(2)])).preview(1, 2);
  assert.deepEqual(r.moves, { conditions: 3, payments: 2, agreements: 1, matters: 1 });
  assert.deepEqual(r.blockers, []);
});

test("個人と法人は統合できない。源泉と取適法の扱いが変わる", async () => {
  const r = await new PartyMergeService(
    build([party(1, { kind: "individual" }), party(2, { kind: "corporate" })])).preview(1, 2);
  assert.match(r.blockers.join(), /区分が違います.*源泉と取適法/);
});

test("すでに統合されたものは統合できない", async () => {
  const r = await new PartyMergeService(
    build([party(1, { status: "merged" }), party(2)])).preview(1, 2);
  assert.match(r.blockers.join(), /すでに統合されています/);
});

test("統合先が別へ統合されていたら止める。連鎖を作らせない", async () => {
  const r = await new PartyMergeService(
    build([party(1), party(2, { status: "merged", merged_into_id: 3 })])).preview(1, 2);
  assert.match(r.blockers.join(), /最終的な統合先を指定/);
});

test("受け皿は統合に使えない", async () => {
  const r = await new PartyMergeService(
    build([party(1, { party_code: "UNRESOLVED" }), party(2)])).preview(1, 2);
  assert.match(r.blockers.join(), /受け皿は統合に使えません/);
});

test("法人番号が違えば警告する。止めはしないが別法人の疑い", async () => {
  const r = await new PartyMergeService(build([
    party(1, { corporate_no: "1111111111111" }),
    party(2, { corporate_no: "2222222222222" })
  ])).preview(1, 2);
  assert.deepEqual(r.blockers, []);
  assert.match(r.warnings.join(), /法人番号が違います/);
});

test("同じ相手先どうしは統合できない", async () => {
  await assert.rejects(
    () => new PartyMergeService(build([party(1)])).preview(1, 1), /同じ取引先どうし/);
});

test("統合しても参照は付け替えない", async () => {
  const db = build([party(1), party(2)]);
  await new PartyMergeService(db).merge(1, 2, "kuramochi");

  const rewrites = db.queries.filter((q) =>
    /UPDATE (conditions|payments|agreements|matters)/i.test(q.text));
  assert.equal(rewrites.length, 0,
    "参照を書き換えると取り消せなくなり、書き換え漏れにも気づけない");

  const marked = db.queries.find((q) => q.text.includes("status = 'merged'"))!;
  assert.deepEqual(marked.params, [1, 2]);
});

test("統合元の名前を統合先の別名に残す。検索で辿れなくなると困る", async () => {
  const db = build([party(1, { name: "旧・株式会社甲" }), party(2)]);
  await new PartyMergeService(db).merge(1, 2, "k");
  const aliasUpdate = db.find("aliases")!;
  assert.equal(aliasUpdate.params[1], "旧・株式会社甲");
});

test("止める条件があれば書き込まない", async () => {
  const db = build([party(1, { kind: "individual" }), party(2)]);
  await assert.rejects(() => new PartyMergeService(db).merge(1, 2, "k"), /区分が違います/);
  assert.ok(!db.queries.some((q) => q.text.includes("status = 'merged'")));
});

test("統合は取り消せる。印を外すだけで元に戻る", async () => {
  const db = new FakeDatabase((t) =>
    t.includes("FROM parties WHERE id")
      ? [{ id: 1, name: "取引先1", status: "merged", merged_into_id: 2 }] : undefined);
  const r = await new PartyMergeService(db).unmerge(1, "k");
  assert.equal(r.id, 1);
  assert.ok(db.queries.some((q) => q.text.includes("status = 'active'")));
});

test("統合されていないものは取り消せない", async () => {
  const db = new FakeDatabase((t) =>
    t.includes("FROM parties WHERE id")
      ? [{ id: 1, name: "取引先1", status: "active", merged_into_id: null }] : undefined);
  await assert.rejects(() => new PartyMergeService(db).unmerge(1, "k"), /統合されていません/);
});
