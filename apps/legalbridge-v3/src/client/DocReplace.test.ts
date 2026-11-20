import { test } from "node:test";
import assert from "node:assert/strict";
import { initialReplacePick } from "./DocReplace.js";

const doc = (id: number, issuedOn: string) => ({
  id, documentNo: `D-${id}`, label: "条件書", title: null, status: "issued", issuedOn, imported: false, agreementId: 1, conditionCount: 84
});

test("差し替え：2 枚以上なら、いちばん新しい文書を新しい側、残りを古い側に選んでおく", () => {
  const docs = [doc(10, "2026-11-02"), doc(30, "2026-11-17"), doc(20, "2026-11-10")];
  assert.deepEqual(initialReplacePick(docs, null), { olds: [20, 10], next: 30 });
});

test("差し替え：行から開いたら、その文書を古い側に。新しい側はほかでいちばん新しいもの", () => {
  const docs = [doc(10, "2026-11-02"), doc(30, "2026-11-17"), doc(20, "2026-11-10")];
  assert.deepEqual(initialReplacePick(docs, 30), { olds: [30], next: 20 });
  assert.deepEqual(initialReplacePick(docs, 10), { olds: [10], next: 30 });
});

test("差し替え：1 枚だけなら古い側に選び、新しい文書は探して選ぶ", () => {
  assert.deepEqual(initialReplacePick([doc(10, "2026-11-02")], null), { olds: [10], next: null });
  assert.deepEqual(initialReplacePick([], null), { olds: [], next: null });
});
