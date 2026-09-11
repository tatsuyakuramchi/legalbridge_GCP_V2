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

test("どの版から開いても、系列ぜんぶを同じ並びで返す", async () => {
  const db = new FakeDatabase((t) => (t.includes("FROM conditions c") ? chain : []));
  const rows = await new ConditionRepository(db).revisions(2);

  const sql = db.find("FROM conditions c")!.text;
  // superseded_by_id の鎖ではなく系列で引く。予約の版はまだ旧版を差し替えて
  // いないので鎖に入らず、「いつから適用の改訂が控えているか」が出せない。
  assert.match(sql, /c\.series_id = \(SELECT series_id FROM conditions WHERE id = \$1\)/);
  assert.doesNotMatch(sql, /WITH RECURSIVE/);
  assert.match(sql, /ORDER BY c\.effective_from/, "適用開始日の順に並べる");

  assert.deepEqual(rows.map((r) => r.revision), [1, 2], "古い順に第N版を振る");
  assert.deepEqual(rows.map((r) => r.conditionNo), ["CND-2026-00001", "CND-2026-00001-R2"]);
});

test("生きているのは active の版だけ", async () => {
  const db = new FakeDatabase((t) => (t.includes("FROM conditions c") ? chain : []));
  const rows = await new ConditionRepository(db).revisions(1);
  assert.deepEqual(rows.map((r) => r.live), [false, true]);
  assert.equal(rows[0].status, "superseded");
});

test("版ごとに実績と文書の数を返す（消してよいかの判断に使う）", async () => {
  const db = new FakeDatabase((t) => (t.includes("FROM conditions c") ? chain : []));
  const rows = await new ConditionRepository(db).revisions(1);
  assert.equal(rows[0].eventCount, 1);
  assert.equal(rows[0].documentCount, 1);
  assert.equal(rows[1].eventCount, 0);
});

test("適用待ちの版も系列に出す（鎖を辿ると見えない）", async () => {
  const withPending = [...chain, {
    id: 3, condition_no: "CND-2026-00001-R3", name: "配信許諾", status: "scheduled",
    superseded_by_id: null, effective_from: "2027-04-01",
    pricing_model: "revenue_rate", rate_ppm: 180000, currency: "JPY",
    mg_amount: 800000, tax_category: "taxable", created_at: "2026-12-01T00:00:00Z",
    updated_at: "2026-12-01T00:00:00Z", event_count: 0, document_count: 0 }];
  const db = new FakeDatabase((t) => (t.includes("FROM conditions c") ? withPending : []));
  const rows = await new ConditionRepository(db).revisions(2);
  assert.equal(rows.length, 3);
  assert.equal(rows[2].status, "scheduled");
  assert.equal(rows[2].effectiveFrom, "2027-04-01");
  assert.equal(rows[2].live, false, "適用日が来るまで効いていない");
});
