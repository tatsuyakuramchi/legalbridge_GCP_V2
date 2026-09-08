import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { ConditionRepository } from "./repository.js";

const chain = [
  { id: 1, condition_no: "CND-2026-00001", name: "配信許諾", status: "superseded",
    superseded_by_id: 2, pricing_model: "revenue_rate", rate_ppm: 100000, currency: "JPY",
    mg_amount: 500000, tax_category: "taxable", created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z", event_count: 1, document_count: 1 },
  { id: 2, condition_no: "CND-2026-00001-R2", name: "配信許諾", status: "active",
    superseded_by_id: null, pricing_model: "revenue_rate", rate_ppm: 150000, currency: "JPY",
    mg_amount: 800000, tax_category: "taxable", created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z", event_count: 0, document_count: 0 }
];

test("どの版から開いても、前後どちらへも辿って同じ並びを返す", async () => {
  const db = new FakeDatabase((t) => (t.includes("WITH RECURSIVE") ? chain : []));
  const rows = await new ConditionRepository(db).revisions(2);

  const sql = db.find("WITH RECURSIVE")!.text;
  assert.match(sql, /back\(id\)/, "自分を差し替えた先を辿る");
  assert.match(sql, /fwd\(id\)/, "自分の差し替え先を辿る");
  assert.match(sql, /c\.superseded_by_id = b\.id/);
  assert.match(sql, /c\.superseded_by_id FROM conditions c JOIN fwd/);

  assert.deepEqual(rows.map((r) => r.revision), [1, 2], "古い順に第N版を振る");
  assert.deepEqual(rows.map((r) => r.conditionNo), ["CND-2026-00001", "CND-2026-00001-R2"]);
});

test("生きているのは active の版だけ", async () => {
  const db = new FakeDatabase((t) => (t.includes("WITH RECURSIVE") ? chain : []));
  const rows = await new ConditionRepository(db).revisions(1);
  assert.deepEqual(rows.map((r) => r.live), [false, true]);
  assert.equal(rows[0].status, "superseded");
});

test("版ごとに実績と文書の数を返す（消してよいかの判断に使う）", async () => {
  const db = new FakeDatabase((t) => (t.includes("WITH RECURSIVE") ? chain : []));
  const rows = await new ConditionRepository(db).revisions(1);
  assert.equal(rows[0].eventCount, 1);
  assert.equal(rows[0].documentCount, 1);
  assert.equal(rows[1].eventCount, 0);
});
