import test from "node:test";
import assert from "node:assert/strict";
import {
  assertUsageInput, basisKindOf, basisNoteOf, basisOf, methodLabelOf,
  usageTypeSpec, USAGE_TYPES
} from "./usage-type.js";
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
  // 自社製造・他社販売は「個数×単価」でも「受領額そのもの」でも入れられる。
  assert.deepEqual(usageTypeSpec("oem")?.fields,
    ["unitAmount", "quantity", "sampleQuantity", "grossAmount"]);
  assert.equal(USAGE_TYPES.filter((t) => t.needsOutCondition).length, 2);
  // 前金・後金は相手のいる形だけ。自社製造・自社販売には入金の相手がいない。
  assert.deepEqual(USAGE_TYPES.filter((t) => t.hasStages).map((t) => t.value),
    ["sublicense", "oem"]);
});

// ---- 前金・後金（契約金と残金で2回に分かれる契約） ----

test("自社製造・他社販売は、個数×単価でも受領額そのものでも入れられる", () => {
  assert.equal(basisOf({ usageType: "oem", unitAmount: 300, quantity: 5000 }, "行"), 1_500_000);
  assert.equal(basisOf({ usageType: "oem", grossAmount: 1_000_000 }, "行"), 1_000_000);
});

test("受領額と「個数 × 単価」の両方が入った行は止める", () => {
  // どちらで計算したのか決められない。片方を勝たせると、人が見ていない側の
  // 数字が紙に出ないまま残る。
  assert.throws(
    () => basisOf({ usageType: "oem", unitAmount: 300, quantity: 5000,
                    grossAmount: 1_000_000 }, "行"),
    (e: unknown) => e instanceof DomainError && /両方は入れられません/.test(e.message));
});

test("前金・後金は方式名と内訳の両方に出す。同じ行が2本並ぶのを防ぐ", () => {
  const advance = { usageType: "oem" as const, unitAmount: 300, quantity: 5000,
                    paymentStage: "advance" as const };
  const balance = { ...advance, unitAmount: 500, paymentStage: "balance" as const };
  assert.equal(methodLabelOf(advance), "自社製造・他社販売（前金・受領価格 × 製造個数）");
  assert.equal(methodLabelOf(balance), "自社製造・他社販売（後金・受領価格 × 製造個数）");
  assert.equal(basisNoteOf(advance), "前金　5000個 × 受領価格");
  assert.equal(basisNoteOf(balance), "後金　5000個 × 受領価格");
  // 定額の前金は形も変えて出す。
  assert.equal(methodLabelOf({ usageType: "oem", grossAmount: 1, paymentStage: "advance" }),
    "自社製造・他社販売（前金・受領価格）");
});

test("前金・後金を付けられるのは相手のいる形だけ", () => {
  assert.throws(
    () => assertUsageInput({ usageType: "in_house", unitAmount: 1, quantity: 1,
                             paymentStage: "advance" }, "行"),
    (e: unknown) => e instanceof DomainError && /前金・後金の区別は付きません/.test(e.message));
  assertUsageInput({ usageType: "sublicense", grossAmount: 1, outConditionId: 9,
                     paymentStage: "advance" }, "行");
});

test("どちらの形で入れたかは、入っている数字から読み分けられる", () => {
  assert.equal(basisKindOf({ usageType: "oem", unitAmount: 300, quantity: 5000 }), "per_unit");
  assert.equal(basisKindOf({ usageType: "oem", grossAmount: 1_000_000 }), "lump");
  assert.equal(basisKindOf({ usageType: "sublicense", grossAmount: 1 }), "lump");
  assert.equal(basisKindOf({ usageType: "in_house", unitAmount: 1, quantity: 1 }), "per_unit");
});
