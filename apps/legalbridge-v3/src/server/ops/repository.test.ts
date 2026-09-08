import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { OpsRepository } from "./repository.js";

const rows = [
  { source: "task", ref_id: 1, ref_no: "MTR-1", title: "納品日確認",
    due_on: new Date(2026, 6, 28), status: "todo", overdue: true },
  { source: "matter", ref_id: 2, ref_no: "MTR-2", title: "NDA",
    due_on: new Date(2026, 8, 20), status: "open", overdue: false }
];

test("期限切れは下限なしで全部返す", async () => {
  const db = new FakeDatabase((t) => (t.includes("FROM v_deadlines") ? rows : undefined));
  await new OpsRepository(db).deadlines(14);

  const q = db.find("FROM v_deadlines")!;
  assert.ok(!/current_date\s*-/.test(q.text),
    "過ぎた期限に下限を付けない。古いほど危険なのに古いほど見えなくなる");
  assert.ok(q.text.includes("due_on <= current_date"), "先の期限だけを絞る");
});

test("超過しているかを行ごとに返す", async () => {
  const db = new FakeDatabase((t) => (t.includes("FROM v_deadlines") ? rows : undefined));
  const list = await new OpsRepository(db).deadlines(14);

  assert.equal(list[0].overdue, true);
  assert.equal(list[1].overdue, false);
  assert.equal(list[0].dueOn, "2026-07-28", "日付は文字列で返す");
});

test("先を見る日数は範囲に収める", async () => {
  const db = new FakeDatabase();
  const repo = new OpsRepository(db);
  await repo.deadlines(9999);
  assert.equal(db.queries.at(-1)!.params[0], 365);
  await repo.deadlines(-5);
  assert.equal(db.queries.at(-1)!.params[0], 1);
});
