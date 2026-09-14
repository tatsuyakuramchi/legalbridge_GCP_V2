import test from "node:test";
import assert from "node:assert/strict";
import {
  assertUsageInput, basisKindOf, basisNoteOf, basisOf, methodLabelOf, netOfTax,
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

// ---- 税込の受領額（受領元が海外のとき） ----

test("税込で入っている受領額は、割り戻してから料率を掛ける", () => {
  // 税込 1,100,000 を税別 1,000,000 に直す。直さないと 10% 多く払う。
  assert.equal(basisOf({ usageType: "sublicense", grossAmount: 1_100_000,
                         taxIncluded: true }, "行"), 1_000_000);
  assert.equal(basisOf({ usageType: "sublicense", grossAmount: 1_100_000 }, "行"), 1_100_000);
});

test("他社販売の受領価格（1個）も割り戻す", () => {
  assert.equal(basisOf({ usageType: "oem", unitAmount: 880, quantity: 1000,
                         taxIncluded: true }, "行"), 800_000);
  // 定額の前金も受領した額なので割り戻す。
  assert.equal(basisOf({ usageType: "oem", grossAmount: 1_100_000,
                         taxIncluded: true }, "行"), 1_000_000);
});

test("基準価格は自社の定価なので割り戻さない", () => {
  // 自社製造・自社販売に受領は無い。税込のつまみが効くと定価が目減りする。
  assert.equal(basisOf({ usageType: "in_house", unitAmount: 1100, quantity: 100,
                         taxIncluded: true }, "行"), 110_000);
});

test("端数は切り捨てる。割り戻した額に税を足して元を超えさせない", () => {
  // 1,000 ÷ 1.1 = 909.09…。910 にすると 910 × 1.1 = 1,001 で入金を超える。
  assert.equal(netOfTax(1000, true), 909);
  assert.equal(netOfTax(1000, false), 1000);
  assert.equal(netOfTax(1000, null), 1000);
});

test("割り戻したことを紙に出す。相手が検算できないと問い合わせになる", () => {
  assert.equal(basisNoteOf({ usageType: "sublicense", grossAmount: 1, taxIncluded: true }),
    "受領価格（税込 ÷ 1.1）");
  assert.equal(basisNoteOf({ usageType: "oem", unitAmount: 1, quantity: 1000,
                             taxIncluded: true }),
    "1000個 × 受領価格（税込 ÷ 1.1）");
  assert.equal(basisNoteOf({ usageType: "sublicense", grossAmount: 1 }), "受領価格");
});

test("他社販売は受領額 × 料率が既定。個数と単価が揃った行だけ個数建て", () => {
  // 海外から売上が入ってくる取引には個数が無い。再許諾と同じ計算になる。
  assert.equal(basisKindOf({ usageType: "oem", grossAmount: 1_000_000 }), "lump");
  assert.equal(basisKindOf({ usageType: "oem" }), "lump", "何も無ければ受領額の形");
  assert.equal(basisKindOf({ usageType: "oem", quantity: 1000 }), "lump",
    "個数だけでは個数建てにしない");
  assert.equal(basisKindOf({ usageType: "oem", unitAmount: 800, quantity: 1000 }), "per_unit");
});

test("受領額の形は、紙にも個数を出さない", () => {
  assert.equal(basisNoteOf({ usageType: "oem", grossAmount: 1_000_000 }), "受領価格");
  assert.equal(methodLabelOf({ usageType: "oem", grossAmount: 1_000_000 }),
    "自社製造・他社販売（受領価格）");
});

test("画面が形を指定していれば、数字が揃う前でもその形で読む", () => {
  // 入力中は数字がまだ入っていない。数字から読むと、人が「受領額 × 料率」を
  // 選んだ直後に方式名が「× 製造個数」と出て、選んだ形と食い違って見える。
  assert.equal(basisKindOf({ usageType: "oem", basisKind: "lump" }), "lump");
  assert.equal(basisKindOf({ usageType: "oem", basisKind: "per_unit" }), "per_unit");
  assert.equal(
    methodLabelOf({ usageType: "oem", basisKind: "lump", paymentStage: "advance" }),
    "自社製造・他社販売（前金・受領価格）");
});

test("指定が無ければ、保存した行は入っている数字から読む", () => {
  assert.equal(basisKindOf({ usageType: "oem", grossAmount: 100000 }), "lump");
  assert.equal(basisKindOf({ usageType: "oem", unitAmount: 500, quantity: 10 }), "per_unit");
});
