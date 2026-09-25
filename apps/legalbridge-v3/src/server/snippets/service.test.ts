import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { DomainError } from "../core/errors.js";
import { SnippetService, SNIPPET_CATEGORIES, parseSnippet } from "./service.js";

const ROW: Record<string, unknown> = {
  id: 7, category: "scope", title: "全世界・全言語（標準）",
  body: "本許諾の範囲は全世界・全言語とする。", sort_order: 10
};

const db = (row: Record<string, unknown> | null = ROW) =>
  new FakeDatabase((t) => {
    if (t.includes("INSERT INTO text_snippets")) return row ? [row] : [];
    if (t.includes("UPDATE text_snippets\n")) return row ? [row] : [];
    if (t.includes("UPDATE text_snippets SET is_active")) return row ? [row] : [];
    if (t.includes("FROM text_snippets")) return row ? [row] : [];
    return undefined;
  });

test("使える文面だけを、区分・表示順の順で返す", async () => {
  const d = db();
  const list = await new SnippetService(d).list();

  assert.deepEqual(list, [{
    id: 7, category: "scope", title: "全世界・全言語（標準）",
    body: "本許諾の範囲は全世界・全言語とする。", sortOrder: 10
  }]);
  const q = d.find("FROM text_snippets")!;
  assert.match(q.text, /WHERE is_active/, "外した文面は出さない");
  assert.match(q.text, /array_position/, "区分の並びは表示の順に固定する");
  assert.deepEqual(q.params[0], [...SNIPPET_CATEGORIES]);
});

test("足したら監査に残る", async () => {
  const d = db();
  const saved = await new SnippetService(d).create(
    { category: "scope", title: "全世界・全言語（標準）",
      body: "本許諾の範囲は全世界・全言語とする。", sortOrder: 10 }, "kuramochi");

  assert.equal(saved.id, 7);
  assert.deepEqual(d.find("INSERT INTO text_snippets")!.params,
    ["scope", "全世界・全言語（標準）", "本許諾の範囲は全世界・全言語とする。", 10]);
  const audit = d.find("INSERT INTO audit_events")!;
  assert.equal(audit.params[1], "snippet.create");
});

test("区分を省いたら特約・備考に入る（V2 と同じ既定）", async () => {
  assert.equal(parseSnippet({ title: "秘密保持" }).category, "special_terms");
});

test("表に無い区分は断る（CHECK に当たって落ちる前に止める）", () => {
  assert.throws(
    () => parseSnippet({ category: "license", title: "x" }),
    (e: unknown) => e instanceof DomainError && e.code === "VALIDATION");
});

test("名前の無い文面は作れない（一覧で選べなくなる）", () => {
  assert.throws(
    () => parseSnippet({ title: "  " }),
    (e: unknown) => e instanceof DomainError && /空にできません/.test(e.message));
});

test("本文は空でもよい（名前だけ先に決めて後から書く）", () => {
  assert.equal(parseSnippet({ title: "検討中の条項" }).body, "");
});

test("外すのは論理削除。行は消さない", async () => {
  const d = db({ title: "古い言い回し" });
  await new SnippetService(d).deactivate(7, "kuramochi");

  assert.equal(d.all("DELETE FROM text_snippets").length, 0, "消さない");
  assert.match(d.find("UPDATE text_snippets SET is_active")!.text, /is_active = false/);
  assert.equal(d.find("INSERT INTO audit_events")!.params[1], "snippet.deactivate");
});

test("既に外してある文面は外せない（二度目の記録を残さない）", async () => {
  const d = db(null);
  await assert.rejects(
    () => new SnippetService(d).deactivate(7, "k"),
    (e: unknown) => e instanceof DomainError && e.code === "NOT_FOUND");
  assert.equal(d.all("INSERT INTO audit_events").length, 0);
});

test("外した文面は直せない（一覧に戻らないものを書き換えない）", async () => {
  const d = db(null);
  await assert.rejects(
    () => new SnippetService(d).update(7, { title: "新しい名前" }, "k"),
    (e: unknown) => e instanceof DomainError && e.code === "NOT_FOUND");
});
