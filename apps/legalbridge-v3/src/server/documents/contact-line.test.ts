import test from "node:test";
import assert from "node:assert/strict";
import { splitContact, joinContactParts, mergeContactPick } from "./contact-line.js";

/**
 * 通知先の欄（部署 ／ 氏名 ／ メール ／ 電話）。
 * 候補から選んだとき、入れたつもりのない欄が消えないことを見張る。
 */

test("1行を4つに戻し、同じ1行に戻る", () => {
  const line = "編集部 ／ 編集 花子 ／ hanako@example.test ／ 03-1111-1111";
  assert.deepEqual(splitContact(line),
    { department: "編集部", name: "編集 花子", email: "hanako@example.test", phone: "03-1111-1111" });
  assert.equal(joinContactParts(splitContact(line)), line);
});

test("欄が欠けていても読める（氏名だけ・氏名とメールだけ）", () => {
  assert.deepEqual(splitContact("甲野 甲太"),
    { department: "", name: "甲野 甲太", email: "", phone: "" });
  assert.deepEqual(splitContact("甲野 甲太 ／ kono@example.test"),
    { department: "", name: "甲野 甲太", email: "kono@example.test", phone: "" });
});

test("候補は1つぶんだけ差し替える（ほかの欄は消さない）", () => {
  const line = "編集部 ／ 編集 花子 ／ hanako@example.test ／ 03-1111-1111";
  assert.equal(mergeContactPick(line, "山田 太郎 のメール", "taro@example.test"),
    "編集部 ／ 編集 花子 ／ taro@example.test ／ 03-1111-1111");
  assert.equal(mergeContactPick(line, "山田 太郎 の氏名", "山田 太郎"),
    "編集部 ／ 山田 太郎 ／ hanako@example.test ／ 03-1111-1111");
  assert.equal(mergeContactPick(line, "山田 太郎 の部署", "法務部"),
    "法務部 ／ 編集 花子 ／ hanako@example.test ／ 03-1111-1111");
  assert.equal(mergeContactPick(line, "山田 太郎 の電話", "03-2222-2222"),
    "編集部 ／ 編集 花子 ／ hanako@example.test ／ 03-2222-2222");
});

test("札が読めなくても値の形で入る先を決める", () => {
  assert.equal(mergeContactPick("編集部 ／ 編集 花子", "前回の文言", "taro@example.test"),
    "編集部 ／ 編集 花子 ／ taro@example.test");
  assert.equal(mergeContactPick("編集部 ／ 編集 花子", "前回の文言", "03-2222-2222"),
    "編集部 ／ 編集 花子 ／ 03-2222-2222");
});

test("4つ揃った1行はそのまま入れ替える", () => {
  const whole = "法務部 ／ 山田 太郎 ／ taro@example.test ／ 03-2222-2222";
  assert.equal(mergeContactPick("編集部 ／ 編集 花子", "前回の文言", whole), whole);
});

test("空の候補では変えない（押し間違いで消さない）", () => {
  assert.equal(mergeContactPick("編集部 ／ 編集 花子", "の氏名", ""), "編集部 ／ 編集 花子");
});
