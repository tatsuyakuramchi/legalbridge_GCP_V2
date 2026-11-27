import { test } from "node:test";
import assert from "node:assert/strict";
import { sortRows } from "./LineItems.js";

test("対象著作物の並べ替え：発行日順（空は後ろ、同じ日は今の順）。行に無ければ自動の行から引く", () => {
  const rows = [
    { title: "C", published_on: "2024-05-01" },
    { title: "A", published_on: null },
    { title: "B", published_on: "2021-03-10" },
    { title: "D" },
    { title: "E", published_on: "2021-03-10" }
  ];
  const seed = [{ title: "D", published_on: "2019-01-01" }];
  assert.deepEqual(sortRows(rows, seed, "published_on").map((r) => r.title), ["D", "B", "E", "C", "A"]);
  assert.deepEqual(sortRows(rows, seed, "published_on", true).map((r) => r.title), ["C", "B", "E", "D", "A"]);
  // 自動の行から引いた日付は行に写る（紙を作り直しても同じ並びのまま）
  assert.equal(sortRows(rows, seed, "published_on")[0]!.published_on, "2019-01-01");
});
