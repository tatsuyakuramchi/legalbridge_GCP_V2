import assert from "node:assert/strict";
import test from "node:test";
import { displayScope, scopeContains } from "./rights-scope.js";

test("WORLDは任意の国を包含する", () => {
  assert.equal(scopeContains(
    [{ code: "WORLD", name: "全世界" }],
    [{ code: "JP", name: "日本" }, { code: "US", name: "アメリカ合衆国" }],
    "WORLD"
  ), true);
});

test("個別国INは範囲外OUTを拒否する", () => {
  assert.equal(scopeContains(
    [{ code: "JP", name: "日本" }, { code: "US", name: "アメリカ合衆国" }],
    [{ code: "DE", name: "ドイツ" }],
    "WORLD"
  ), false);
});

test("ALLは任意の言語を包含しcode比較はcase非依存", () => {
  assert.equal(scopeContains(
    [{ code: "all", name: "全言語" }],
    [{ code: "EN", name: "英語" }, { code: "ja", name: "日本語" }],
    "ALL"
  ), true);
});

test("個別言語INにALLをOUT指定できない", () => {
  assert.equal(scopeContains(
    [{ code: "en", name: "英語" }],
    [{ code: "ALL", name: "全言語" }],
    "ALL"
  ), false);
});

test("互換表示文字列は選択名から生成する", () => {
  assert.equal(displayScope([
    { code: "JP", name: "日本" },
    { code: "US", name: "アメリカ合衆国" }
  ]), "日本、アメリカ合衆国");
});
