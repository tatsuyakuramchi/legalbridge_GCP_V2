import assert from "node:assert/strict";
import test from "node:test";
import { extractVariables, seedFormData } from "./extract-variables.js";

test("『ラベル：値』を正規フィールドへ対応付ける", () => {
  const text = "件名：秘密保持契約\n相手方: 株式会社アークライト\n金額：1,000,000円\n無関係な行";
  const { variables, raw } = extractVariables(text);
  assert.equal(variables.PROJECT_TITLE, "秘密保持契約");
  assert.equal(variables.COUNTERPARTY, "株式会社アークライト");
  assert.equal(variables.AMOUNT, "1,000,000円");
  // rawは対になった行のみ（4行目は対でないが「無関係な行」はコロン無しで除外）。
  assert.equal(raw.length, 3);
});

test("【ラベル】値 形式に対応", () => {
  const { variables } = extractVariables("【作品】ドラゴン英雄譚\n【担当者】田中");
  assert.equal(variables.WORK_TITLE, "ドラゴン英雄譚");
  assert.equal(variables.ASSIGNEE, "田中");
});

test("重複ラベルは最初の値を優先", () => {
  const { variables } = extractVariables("件名：A\n件名：B");
  assert.equal(variables.PROJECT_TITLE, "A");
});

test("空・未知ラベルは変数を生まない", () => {
  assert.deepEqual(extractVariables("").variables, {});
  assert.deepEqual(extractVariables(null).variables, {});
  assert.deepEqual(extractVariables("謎ラベル：値").variables, {});
});

test("seedFormData は空欄のみ補完し既存値を保持", () => {
  const seeded = seedFormData({ PROJECT_TITLE: "既存", COUNTERPARTY: "" }, { PROJECT_TITLE: "新規", COUNTERPARTY: "相手", AMOUNT: "100" });
  assert.equal(seeded.PROJECT_TITLE, "既存"); // 上書きしない
  assert.equal(seeded.COUNTERPARTY, "相手");  // 空欄は補完
  assert.equal(seeded.AMOUNT, "100");         // 新規追加
});
