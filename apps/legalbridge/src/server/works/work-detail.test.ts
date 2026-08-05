import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLineageView, groupWorkConditions, type LineageNode, type WorkConditionLine
} from "./work-detail.js";

const line = (over: Partial<WorkConditionLine>): WorkConditionLine => ({
  id: 1, conditionName: null, direction: null, flowDirection: null,
  sourceMaterialId: null, materialName: null, sublicenseAllowed: null,
  parentLicenseConditionId: null, ratePct: null, amountExTax: null,
  mgAmount: null, currency: null, documentNumber: null, ...over
});

test("groupWorkConditions は方向・サブライセンス・素材紐付で分類する", () => {
  const grouped = groupWorkConditions([
    line({ id: 1, direction: "receivable", sourceMaterialId: 10 }),
    line({ id: 2, direction: "payable", sourceMaterialId: null }),
    line({ id: 3, direction: "receivable", sublicenseAllowed: true, sourceMaterialId: 10 }),
    line({ id: 4, direction: "receivable", parentLicenseConditionId: 99, sourceMaterialId: null })
  ]);
  assert.equal(grouped.totals.count, 4);
  assert.equal(grouped.receivable.length, 3);
  assert.equal(grouped.payable.length, 1);
  // sublicense: id3 (allowed) と id4 (親ライセンスあり)。
  assert.deepEqual(grouped.sublicense.map((l) => l.id), [3, 4]);
  // workLevel: sourceMaterialId==null → id2, id4。
  assert.deepEqual(grouped.workLevel.map((l) => l.id), [2, 4]);
  assert.deepEqual(grouped.materialLinked.map((l) => l.id), [1, 3]);
  assert.equal(grouped.totals.sublicenseCount, 2);
  assert.equal(grouped.totals.workLevelCount, 2);
});

test("groupWorkConditions は空配列でゼロを返す", () => {
  const grouped = groupWorkConditions([]);
  assert.equal(grouped.totals.count, 0);
  assert.deepEqual(grouped.receivable, []);
});

const node = (workId: number, title: string): LineageNode => ({ workId, title, workCode: `W-${workId}` });

test("buildLineageView は原作→selectedを 原作/派生N でラベル付けする", () => {
  const view = buildLineageView(
    3,
    [node(1, "原作A"), node(2, "派生1B"), node(3, "派生2C")],
    [node(4, "孫D")],
    []
  );
  assert.deepEqual(view.chain.map((t) => t.label), ["原作", "派生1", "派生2"]);
  assert.equal(view.chain[2].isSelected, true);
  assert.equal(view.depth, 2);
  assert.equal(view.isDerivative, true);
  assert.deepEqual(view.children.map((c) => c.workId), [4]);
});

test("buildLineageView は原作単体を派生なしとする", () => {
  const view = buildLineageView(1, [node(1, "原作")], [], []);
  assert.equal(view.depth, 0);
  assert.equal(view.isDerivative, false);
  assert.deepEqual(view.chain.map((t) => t.label), ["原作"]);
});

test("buildLineageView は parent_work_id 系譜に無い work_relations 親を未反映として拾う", () => {
  const view = buildLineageView(
    2,
    [node(1, "原作"), node(2, "派生")],
    [],
    [node(1, "原作"), node(9, "別ルート親")] // 1は系譜内、9は未反映
  );
  assert.deepEqual(view.unlinkedRelationParents.map((p) => p.workId), [9]);
});
