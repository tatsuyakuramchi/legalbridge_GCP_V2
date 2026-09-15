import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { ConditionWriteService } from "./write-service.js";

const build = (over: { status?: string; alreadyClosed?: boolean } = {}) =>
  new FakeDatabase((text) => {
    if (text.includes("FROM conditions WHERE id = $1")) {
      return [{ id: 5, condition_no: "CL-1", status: over.status ?? "active" }];
    }
    if (text.includes("SET closed_at = now()")) return over.alreadyClosed ? [] : [{ id: 5 }];
    if (text.includes("SET closed_at = NULL")) return over.alreadyClosed ? [{ id: 5 }] : [];
    return undefined;
  });

test("完了扱いは理由つきで閉じ、状態は変えない。監査に残る", async () => {
  const db = build();
  const r = await new ConditionWriteService(db).close(5, "V2 で支払済み", "k");
  assert.equal(r.changed[0].rows, 1);
  const up = db.find("SET closed_at = now()")!;
  assert.deepEqual(up.params, [5, "V2 で支払済み", "k"]);
  assert.equal(db.all("UPDATE conditions").some((q) => q.text.includes("status =")), false, "状態は触らない");
  assert.equal(db.find("INSERT INTO audit_events")!.params[1], "condition.close");
});

test("理由なし・旧版・二重の完了扱いは止める。取り消しは閉じているときだけ", async () => {
  await assert.rejects(() => new ConditionWriteService(build()).close(5, " ", "k"), /理由は必須/);
  await assert.rejects(() => new ConditionWriteService(build({ status: "superseded" })).close(5, "x", "k"), /改訂済み/);
  await assert.rejects(() => new ConditionWriteService(build({ alreadyClosed: true })).close(5, "x", "k"), /すでに完了扱い/);
  await assert.rejects(() => new ConditionWriteService(build()).reopen(5, "k"), /完了扱いになっていません/);
  const r = await new ConditionWriteService(build({ alreadyClosed: true })).reopen(5, "k");
  assert.equal(r.changed[0].rows, 1);
});
