import test from "node:test";
import assert from "node:assert/strict";
import { duplicateGroups, mergeBlockers } from "./check-service.js";

const row = (id: number, over: Record<string, unknown> = {}) => ({
  id, condition_no: `CI-${id}`, name: "ito｜再許諾", counterparty_id: 1, party_name: "作者A", work_id: 1, work_title: "ito",
  usage_type: "sublicense", rate_ppm: 50000, settlement_mode: null, statement_timing: null, work_part_id: null,
  target_party_id: null, agreement_no: null, events: 0, documents: 0, ...over
});

test("重複：同じ作者 × 作品 × 構成要素 × 利用形態 × 対象の許諾先 だけをまとめる", () => {
  const groups = duplicateGroups([
    row(1), row(2, { events: 3 }),
    row(3, { target_party_id: 9 }),          // 許諾先専用は別
    row(4, { work_part_id: 7 }),             // 構成要素が違えば別
    row(5, { usage_type: "oem" }),           // 利用形態が違えば別
    row(6, { counterparty_id: 2 })           // 作者が違えば別
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].conditions.map((c) => [c.id, c.events]), [[1, 0], [2, 3]]);
  assert.equal(groups[0].conditions[0].timing, "periodic", "型の無い再許諾は時限式と推す");
});

test("まとめられない条件：文書・支払・計算書・取り分のある条件、料率の違う条件、作者・作品などの違う条件", () => {
  const base = { status: "active", counterparty_id: 1, work_id: 1, work_part_id: null, usage_type: "sublicense", target_party_id: null,
                 rate_ppm: 50000, unit_amount: null, currency: "JPY", documents: 0, payments: 0, statements: 0, shares: 0 };
  assert.deepEqual(mergeBlockers(base, { ...base }), []);
  assert.match(mergeBlockers(base, { ...base, documents: 1, payments: 2 }).join("／"), /決定した文書.*支払/);
  assert.match(mergeBlockers(base, { ...base, rate_ppm: 80000 }).join(), /料率・単価・通貨が違う/);
  assert.match(mergeBlockers(base, { ...base, target_party_id: 9 }).join(), /対象の許諾先が同じ条件だけ/);
  assert.match(mergeBlockers(base, { ...base, status: "void" }).join(), /生きている条件どうし/);
});
