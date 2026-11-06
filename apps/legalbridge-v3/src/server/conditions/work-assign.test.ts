import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { ConditionWorkService } from "./work-assign.js";

const db = (rows: Array<Record<string, unknown>>, work: Record<string, unknown> | null = { id: 3, title: "星海のアトラス" }) =>
  new FakeDatabase((t) => {
    if (t.includes("FROM works WHERE id")) return work ? [work] : [];
    if (t.includes("FROM conditions c LEFT JOIN works w")) return rows;
    return undefined;
  });

test("作品の無い条件は作品に入れ、系列ぜんぶを書き換える", async () => {
  const d = db([{ id: 5, work_id: null, work_title: null, series: 4, issued: false }]);
  const r = await new ConditionWorkService(d).assign([5], 3, "legal");
  assert.deepEqual([r.updated, r.skipped], [[5], []]);
  const u = d.find("UPDATE conditions SET work_id")!;
  assert.deepEqual(u.params, [3, [4]]);
  assert.ok(u.text.includes("work_part_id = NULL"));
  assert.equal(d.find("INSERT INTO audit_events")!.params[1], "condition.assign_work");
});

test("作品が付いていて決定した文書がある条件は付け替えない。同じ作品・見つからない条件も飛ばす", async () => {
  const d = db([
    { id: 5, work_id: 9, work_title: "白銀の航路", series: 5, issued: true },
    { id: 6, work_id: 3, work_title: "星海のアトラス", series: 6, issued: false },
    { id: 7, work_id: 9, work_title: "白銀の航路", series: 7, issued: false }
  ]);
  const r = await new ConditionWorkService(d).assign([5, 6, 7, 8], 3, "legal");
  assert.deepEqual(r.updated, [7], "決定した文書が無ければ付け替える");
  assert.deepEqual(r.skipped.map((x) => x.conditionId).sort(), [5, 6, 8]);
  assert.match(r.skipped.find((x) => x.conditionId === 5)!.reason, /決定した文書があるので付け替えません/);
});

test("作品が無い・条件を選んでいないときは断る", async () => {
  await assert.rejects(new ConditionWorkService(db([], null)).assign([5], 3, "legal"), /作品 3 が見つかりません/);
  await assert.rejects(new ConditionWorkService(db([])).assign([], 3, "legal"), /条件を選んでください/);
});
