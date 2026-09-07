import test from "node:test";
import assert from "node:assert/strict";
import { checkAgainstEnvelope } from "./envelope.js";
import type { RightsEnvelope } from "../core/model.js";

// 本文（出版・電子配信・商品化）と挿絵（出版・電子配信）を取得した作品。
// 包絡は積なので媒体は出版・電子配信まで、期間は挿絵の期日まで。
const envelope: RightsEnvelope = {
  workId: 10, workCode: "WRK-10013", title: "星降る夜のミュゼ",
  acquiredCount: 2,
  termLimit: "2029-03-31", termLimitedBy: "CL-2025-00312",
  exclusivityLimit: "non_exclusive", exclusivityLimitedBy: "CL-2025-00311",
  sublicensable: true, sublicenseLimitedBy: null,
  scopes: [
    { scopeType: "media", labels: ["出版", "電子配信"] },
    { scopeType: "region", labels: ["台湾", "香港", "マカオ", "北米"] }
  ]
};

const condition = (over: Partial<Parameters<typeof checkAgainstEnvelope>[0]> = {}) => ({
  scopes: [], termEnd: null, exclusivity: null, sublicensable: null, ...over
});

test("上限内の展開は inside", () => {
  const result = checkAgainstEnvelope(condition({
    scopes: [
      { scopeType: "region", label: "台湾", code: null },
      { scopeType: "media", label: "電子配信", code: null }
    ],
    termEnd: "2029-03-31"
  }), envelope);
  assert.equal(result.verdict, "inside");
  assert.deepEqual(result.violations, []);
});

test("商品化は媒体の上限外（本文だけ見ると通ってしまう誤判定を防ぐ）", () => {
  const result = checkAgainstEnvelope(condition({
    scopes: [{ scopeType: "media", label: "商品化", code: null }]
  }), envelope);
  assert.equal(result.verdict, "outside");
  assert.equal(result.violations[0].dimension, "媒体");
  assert.equal(result.violations[0].actual, "商品化");
  assert.equal(result.violations[0].expected, "出版・電子配信");
});

test("期間が上限を越えると違反になり、狭めている条件を名指しする", () => {
  const result = checkAgainstEnvelope(condition({ termEnd: "2029-06-30" }), envelope);
  assert.equal(result.verdict, "outside");
  assert.equal(result.violations[0].dimension, "期間");
  assert.equal(result.violations[0].limitedBy, "CL-2025-00312");
});

test("非独占で取得したものを独占で許諾はできない", () => {
  const result = checkAgainstEnvelope(condition({ exclusivity: "exclusive" }), envelope);
  assert.equal(result.violations[0].dimension, "独占");
  assert.equal(result.violations[0].limitedBy, "CL-2025-00311");
});

test("上限に指定の無い次元は無制限として扱う", () => {
  const result = checkAgainstEnvelope(condition({
    scopes: [{ scopeType: "language", label: "スワヒリ語", code: null }]
  }), envelope);
  assert.equal(result.verdict, "inside");
});

test("取得条件が1件も無い作品は判定不能（通すも弾くもしない）", () => {
  const result = checkAgainstEnvelope(condition({
    scopes: [{ scopeType: "media", label: "商品化", code: null }]
  }), { ...envelope, acquiredCount: 0 });
  assert.equal(result.verdict, "unknown");
});
