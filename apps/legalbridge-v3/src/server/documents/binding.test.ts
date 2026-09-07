import test from "node:test";
import assert from "node:assert/strict";
import { bindVariables, parseVariables, pick, assertComplete } from "./binding.js";
import { DomainError } from "../core/errors.js";

const context = {
  agreement: { title: "繁体字版 配信許諾契約", counterparty: { name: "晨光數位出版", honorific: "御中" } },
  condition: { conditionNo: "CL-2026-00042", ratePct: 12.5, mgAmount: 1200000, work: { title: "星降る夜のミュゼ" } },
  conditions: [{ name: "繁体字版 電子書籍 配信許諾" }],
  totals: { exTax: 612000 }
};

test("供給元のパスから値を解決する（相手先のキー名が何であっても1本）", () => {
  const result = bindVariables(parseVariables([
    { name: "LICENSEE_NAME", from: "agreement.counterparty.name" },
    { name: "HONORIFIC", from: "agreement.counterparty.honorific" },
    { name: "CONTRACT_TITLE", from: "agreement.title" },
    { name: "RATE", from: "condition.ratePct" },
    { name: "WORK", from: "condition.work.title" }
  ]), context);

  assert.deepEqual(result.values, {
    LICENSEE_NAME: "晨光數位出版", HONORIFIC: "御中",
    CONTRACT_TITLE: "繁体字版 配信許諾契約", RATE: 12.5, WORK: "星降る夜のミュゼ"
  });
  assert.deepEqual(result.derived.sort(), ["CONTRACT_TITLE", "HONORIFIC", "LICENSEE_NAME", "RATE", "WORK"]);
  assert.deepEqual(result.missing, []);
});

test("配列は添字で辿れる", () => {
  const result = bindVariables(parseVariables([{ name: "LINE1", from: "conditions.0.name" }]), context);
  assert.equal(result.values.LINE1, "繁体字版 電子書籍 配信許諾");
});

test("manual は手入力から取り、既定値も効く", () => {
  const result = bindVariables(parseVariables([
    { name: "PERIOD", from: "manual" },
    { name: "REMARKS", default: "特になし" }
  ]), context, { PERIOD: "2026上期" });
  assert.equal(result.values.PERIOD, "2026上期");
  assert.equal(result.values.REMARKS, "特になし");
});

test("供給元が空のときだけ手入力で補える（移行期の欠測用）", () => {
  const result = bindVariables(parseVariables([
    { name: "WORK", from: "condition.work.title" },
    { name: "PART", from: "condition.work.part" }
  ]), context, { WORK: "手入力は使われない", PART: "本文" });
  assert.equal(result.values.WORK, "星降る夜のミュゼ", "データ側があれば優先する");
  assert.equal(result.values.PART, "本文", "データ側が空なら手入力で補う");
  assert.deepEqual(result.derived, ["WORK"]);
});

test("必須の未入力は missing に集まり、発行前に弾ける", () => {
  const result = bindVariables(parseVariables([
    { name: "PERIOD", from: "manual", required: true, label: "対象期間" },
    { name: "AMOUNT", from: "totals.exTax", required: true }
  ]), context);
  assert.deepEqual(result.missing, [{ name: "PERIOD", label: "対象期間" }]);
  assert.throws(() => assertComplete(result),
    (e: unknown) => e instanceof DomainError && e.code === "VALIDATION" && /対象期間/.test(e.message));
});

test("解決できないパスは値を作らない（空文字を焼き付けない）", () => {
  const result = bindVariables(parseVariables([{ name: "X", from: "agreement.missing.deep" }]), context);
  assert.equal("X" in result.values, false);
});

test("pick は途中が null でも落ちない", () => {
  assert.equal(pick({ a: null }, "a.b.c"), undefined);
  assert.equal(pick(context, "condition.conditionNo"), "CL-2026-00042");
});

test("parseVariables は name の無い項目を捨てる", () => {
  assert.equal(parseVariables([{ label: "名前なし" }, { name: "OK" }, null, "x"]).length, 1);
});
