import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { WORK_PART_MISFILED, scanWorkParts } from "./quality-scan.js";

const SUSPECT = {
  id: 24, name: "NewIto_イラスト", part_type: "illustration",
  work_code: "LO-2026-0021", work_title: "ito",
  belongs_code: "W-2026-0001", belongs_title: "New ito",
  condition_count: 6, used_by: "W-2026-0001"
};

const db = (rows: Array<Record<string, unknown>>) =>
  new FakeDatabase((t) => {
    if (t.includes("CROSS JOIN LATERAL")) return rows;
    if (t.includes("UPDATE data_quality_issues")) return [];
    return undefined;
  });

test("名前が別の作品を名乗っている素材を上げる", async () => {
  const d = db([SUSPECT]);
  const result = await scanWorkParts(d);

  assert.deepEqual(result, { opened: 1, resolved: 0 });
  const q = d.find("INSERT INTO data_quality_issues")!;
  assert.equal(q.params[0], WORK_PART_MISFILED);
  assert.equal(q.params[1], 24);
  const detail = JSON.parse(String(q.params[2]));
  assert.equal(detail.part, "NewIto_イラスト");
  assert.equal(detail.filedUnder, "LO-2026-0021 ito");
  assert.equal(detail.looksLike, "W-2026-0001 New ito");
  assert.equal(detail.conditions, 6, "移すと一緒に動く条件の数も残す");
  assert.equal(detail.usedBy, "W-2026-0001");
});

test("同じ素材を二度上げない（見つけ直したら検知日だけ新しくする）", async () => {
  const d = db([SUSPECT]);
  await scanWorkParts(d);
  const sql = d.find("INSERT INTO data_quality_issues")!.text;
  assert.match(sql, /ON CONFLICT \(rule_code, target_type, target_id\) DO UPDATE/);
  assert.match(sql, /status = 'open'/);
});

test("移し終えたものは自分で閉じる", async () => {
  const d = db([SUSPECT]);
  await scanWorkParts(d);
  const close = d.find("UPDATE data_quality_issues")!;
  assert.match(close.text, /status = 'resolved'/);
  assert.deepEqual(close.params[1], [24], "いま見つかっている素材は閉じない");
});

test("1件も無ければ、開いているものを全部閉じる", async () => {
  const d = db([]);
  const result = await scanWorkParts(d);
  assert.equal(result.opened, 0);
  assert.deepEqual(d.find("UPDATE data_quality_issues")!.params[1], []);
});

test("判定は名前で行う。条件とパートの作品が違うことは見ない", async () => {
  // 派生作品が原作のコアロジックを使うのは正常な形。これを不整合にすると、
  // 本番の25件（ito クラシックが ito のコアロジックを使う等）が全部上がる。
  const d = db([]);
  await scanWorkParts(d);
  const sql = d.find("CROSS JOIN LATERAL")!.text;
  assert.doesNotMatch(sql, /c\.work_id IS DISTINCT FROM/);
  assert.match(sql, /n\.n_part <> n\.n_work/, "自分の作品名と同じパートは除く");
  assert.match(sql, /in n\.n_work\) = 0/, "置かれている作品名に含まれる作品名は当てない");
});
