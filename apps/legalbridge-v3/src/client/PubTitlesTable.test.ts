import { test } from "node:test";
import assert from "node:assert/strict";
import { remapRowIds } from "./PubTitlesTable.js";

test("対象著作物を表で直す：台帳を改訂したら、行の条件 id を新しい版に付け替える", () => {
  const row = { title: "A", print_condition_id: 10, digital_condition_id: 11, trans_print_condition_id: null, condition_ids: [10, 11, 12] };
  const out = remapRowIds(row, { 10: 90, 12: 92 });
  assert.equal(out.print_condition_id, 90);
  assert.equal(out.digital_condition_id, 11);
  assert.equal(out.trans_print_condition_id, null);
  assert.deepEqual(out.condition_ids, [90, 11, 92]);
  assert.equal(row.print_condition_id, 10, "元の行は書き換えない");
});
