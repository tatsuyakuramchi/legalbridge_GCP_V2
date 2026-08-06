import assert from "node:assert/strict";
import test from "node:test";
import { upsertSnippet, removeSnippet, filterSnippets, sanitizeSnippets, type Snippet } from "./snippets-store.js";

const s = (id: string, title: string, body = ""): Snippet => ({ id, title, body, updatedAt: "2026-01-01T00:00:00Z" });

test("upsertSnippet は新規を先頭に追加、既存を置換", () => {
  const a = s("1", "A");
  const list = upsertSnippet([], a);
  assert.deepEqual(list.map((x) => x.id), ["1"]);
  const withB = upsertSnippet(list, s("2", "B"));
  assert.deepEqual(withB.map((x) => x.id), ["2", "1"]); // 新規は先頭
  const updated = upsertSnippet(withB, s("1", "A2"));
  assert.equal(updated.find((x) => x.id === "1")?.title, "A2");
  assert.equal(updated.length, 2);
});

test("removeSnippet は該当IDを除去", () => {
  const list = [s("1", "A"), s("2", "B")];
  assert.deepEqual(removeSnippet(list, "1").map((x) => x.id), ["2"]);
});

test("filterSnippets はタイトル・本文を横断検索", () => {
  const list = [s("1", "秘密保持", "NDA条項"), s("2", "支払", "30日以内")];
  assert.deepEqual(filterSnippets(list, "nda").map((x) => x.id), ["1"]);
  assert.deepEqual(filterSnippets(list, "支払").map((x) => x.id), ["2"]);
  assert.equal(filterSnippets(list, "").length, 2);
});

test("sanitizeSnippets は破損データを弾く", () => {
  assert.deepEqual(sanitizeSnippets("bad"), []);
  assert.deepEqual(sanitizeSnippets([{ id: "1", title: "T", body: "B", updatedAt: "x" }, { nope: 1 }, { id: "2", title: "", body: "" }]).map((x) => x.id), ["1"]);
});
