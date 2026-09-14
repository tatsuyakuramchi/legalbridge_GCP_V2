import test from "node:test";
import assert from "node:assert/strict";
import { basisNoteOf, basisOf, assertUsageInput, usageTypeSpec, USAGE_TYPES } from "./usage-type.js";
import { DomainError } from "../core/errors.js";

test("3つの形が、それぞれ要る数字で算定される", () => {
  // 自社製造・自社販売：基準価格 × 個数（見本を引く）
  assert.equal(basisOf({ usageType: "in_house", unitAmount: 1200, quantity: 5000,
                         sampleQuantity: 100 }, "行"), 5_880_000);
  // 再許諾：受領価格そのもの
  assert.equal(basisOf({ usageType: "sublicense", grossAmount: 600_000 }, "行"), 600_000);
  // 自社製造・他社販売：受領価格（1個）× 製造個数
  assert.equal(basisOf({ usageType: "oem", unitAmount: 800, quantity: 2000 }, "行"), 1_600_000);
});

test("見本は作者に払わない。引いた数に料率が掛かる", () => {
  assert.equal(basisOf({ usageType: "in_house", unitAmount: 100, quantity: 10,
                         sampleQuantity: 3 }, "行"), 700);
  assert.equal(basisNoteOf({ usageType: "in_house", quantity: 10, sampleQuantity: 3 }),
    "7個（10 − 見本 3）× 基準価格");
  assert.equal(basisNoteOf({ usageType: "in_house", quantity: 10 }), "10個 × 基準価格");
});

test("足りない数字は 0 で通さず止める。0円の計算書を出さないため", () => {
  const bad = (input: Parameters<typeof basisOf>[0], re: RegExp) =>
    assert.throws(() => basisOf(input, "行"),
      (e: unknown) => e instanceof DomainError && re.test(e.message));
  bad({ usageType: "sublicense" }, /受領価格/);
  bad({ usageType: "in_house", quantity: 10 }, /基準価格/);
  bad({ usageType: "in_house", unitAmount: 100 }, /個数/);
  bad({ usageType: "oem", quantity: 10 }, /受領価格（1個あたり）/);
  bad({ usageType: "in_house", unitAmount: 100, quantity: 3, sampleQuantity: 3 }, /0個/);
});

test("再許諾・他社販売はアウト条件が要る。自社販売には付かない", () => {
  assert.throws(
    () => assertUsageInput({ usageType: "sublicense", grossAmount: 1 }, "行"),
    (e: unknown) => e instanceof DomainError && /アウト条件を選んで/.test(e.message));
  assert.throws(
    () => assertUsageInput({ usageType: "oem", unitAmount: 1, quantity: 1 }, "行"),
    (e: unknown) => e instanceof DomainError && /アウト条件を選んで/.test(e.message));
  assert.throws(
    () => assertUsageInput({ usageType: "in_house", unitAmount: 1, quantity: 1,
                             outConditionId: 9 }, "行"),
    (e: unknown) => e instanceof DomainError && /アウト条件は付きません/.test(e.message));
  // 揃っていれば通る。
  assertUsageInput({ usageType: "sublicense", grossAmount: 1, outConditionId: 9 }, "行");
  assertUsageInput({ usageType: "in_house", unitAmount: 1, quantity: 1 }, "行");
});

test("画面に出す欄は形ごとに決まっている", () => {
  assert.deepEqual(usageTypeSpec("sublicense")?.fields, ["grossAmount"]);
  assert.deepEqual(usageTypeSpec("oem")?.fields, ["unitAmount", "quantity", "sampleQuantity"]);
  assert.equal(USAGE_TYPES.filter((t) => t.needsOutCondition).length, 2);
});
