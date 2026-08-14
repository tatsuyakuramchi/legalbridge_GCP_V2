import assert from "node:assert/strict";
import test from "node:test";
import { isFieldVisible } from "./field-visibility.js";
import type { TemplateField } from "../types.js";

const base: TemplateField = { name: "X", label: "X" };

test("条件なしの項目は常に表示", () => {
  assert.equal(isFieldVisible(base, {}), true);
  assert.equal(isFieldVisible(base, { anything: "value" }), true);
});

test("anyOf: 参照項目の値が一致したときだけ表示", () => {
  const field: TemplateField = { ...base,
    showWhen: { field: "TRANSACTION_MODEL", anyOf: ["License-Out", "Both"] } };
  assert.equal(isFieldVisible(field, { TRANSACTION_MODEL: "License-Out" }), true);
  assert.equal(isFieldVisible(field, { TRANSACTION_MODEL: "Both" }), true);
  assert.equal(isFieldVisible(field, { TRANSACTION_MODEL: "Product-Out" }), false);
  // 未選択（空・未定義）は非表示 — モデル選択前に両 Schedule を出さない
  assert.equal(isFieldVisible(field, { TRANSACTION_MODEL: "" }), false);
  assert.equal(isFieldVisible(field, {}), false);
});

test("truthy: boolean 項目のチェック有無で表示を切り替える", () => {
  const on: TemplateField = { ...base, showWhen: { field: "ANNEX_1_INCLUDED", truthy: true } };
  assert.equal(isFieldVisible(on, { ANNEX_1_INCLUDED: true }), true);
  assert.equal(isFieldVisible(on, { ANNEX_1_INCLUDED: false }), false);
  assert.equal(isFieldVisible(on, {}), false);
});

test("不正な条件（判定方法なし・field欠落）は表示にフォールバック", () => {
  assert.equal(isFieldVisible({ ...base, showWhen: { field: "Y" } }, {}), true);
  assert.equal(isFieldVisible(
    { ...base, showWhen: { field: "", anyOf: ["a"] } }, {}), true);
});

test("anyOf は文字列化して比較する（数値・真偽値でも落ちない）", () => {
  const field: TemplateField = { ...base, showWhen: { field: "N", anyOf: ["1"] } };
  assert.equal(isFieldVisible(field, { N: 1 }), true);
  assert.equal(isFieldVisible(field, { N: 2 }), false);
});

test("配列は AND：すべての条件を満たしたときだけ表示", () => {
  const field: TemplateField = { ...base, showWhen: [
    { field: "ANNEX_2_INCLUDED", truthy: true },
    { field: "TRANSACTION_MODEL", anyOf: ["Product-Out", "Both"] }
  ] };
  assert.equal(isFieldVisible(field,
    { ANNEX_2_INCLUDED: true, TRANSACTION_MODEL: "Product-Out" }), true);
  assert.equal(isFieldVisible(field,
    { ANNEX_2_INCLUDED: true, TRANSACTION_MODEL: "License-Out" }), false);
  assert.equal(isFieldVisible(field,
    { ANNEX_2_INCLUDED: false, TRANSACTION_MODEL: "Both" }), false);
  assert.equal(isFieldVisible({ ...base, showWhen: [] }, {}), true);
});
