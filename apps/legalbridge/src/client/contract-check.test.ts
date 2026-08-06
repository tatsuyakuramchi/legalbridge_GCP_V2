import assert from "node:assert/strict";
import test from "node:test";
import { checkWorkConditions, summarizeFindings, type CheckCondition } from "./contract-check.js";

const c = (over: Partial<CheckCondition> & { id: number }): CheckCondition => ({
  conditionName: "条件", direction: "payable", sourceMaterialId: 1, sublicenseAllowed: false,
  parentLicenseConditionId: null, ratePct: null, mgAmount: null, ...over
});

test("サブライセンス許諾で上流未リンクは重大", () => {
  const f = checkWorkConditions([c({ id: 1, sublicenseAllowed: true, parentLicenseConditionId: null })]);
  assert.ok(f.some((x) => x.code === "SUBLICENSE_WITHOUT_PARENT" && x.severity === "high"));
});

test("上流リンクありなら指摘なし", () => {
  const f = checkWorkConditions([c({ id: 1, sublicenseAllowed: true, parentLicenseConditionId: 99 })]);
  assert.equal(f.filter((x) => x.code === "SUBLICENSE_WITHOUT_PARENT").length, 0);
});

test("MGありで料率未設定は注意", () => {
  const f = checkWorkConditions([c({ id: 1, mgAmount: 10000, ratePct: null })]);
  assert.ok(f.some((x) => x.code === "MG_WITHOUT_RATE" && x.severity === "medium"));
});

test("受取条件が素材未紐付けは軽微／条件名空は軽微", () => {
  const f = checkWorkConditions([c({ id: 1, direction: "receivable", sourceMaterialId: null, conditionName: "" })]);
  assert.ok(f.some((x) => x.code === "RECEIVABLE_WITHOUT_MATERIAL"));
  assert.ok(f.some((x) => x.code === "MISSING_NAME"));
});

test("整合した条件は指摘ゼロ", () => {
  const f = checkWorkConditions([c({ id: 1, direction: "payable", ratePct: 10, mgAmount: 5000, sourceMaterialId: 2, conditionName: "OK" })]);
  assert.equal(f.length, 0);
});

test("summarizeFindings は重大度別に集計", () => {
  const f = checkWorkConditions([
    c({ id: 1, sublicenseAllowed: true, parentLicenseConditionId: null }),
    c({ id: 2, mgAmount: 100, ratePct: null }),
    c({ id: 3, conditionName: "" })
  ]);
  const s = summarizeFindings(f);
  assert.equal(s.high, 1);
  assert.ok(s.medium >= 1);
  assert.ok(s.low >= 1);
  assert.equal(s.total, f.length);
});
