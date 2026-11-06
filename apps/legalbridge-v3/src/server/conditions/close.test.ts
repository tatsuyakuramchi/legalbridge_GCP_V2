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

// ---- 過去分として完了（199） ----

const archiveDb = (rows: Array<Record<string, unknown>>, hasColumn = true) =>
  new FakeDatabase((text) => {
    if (text.includes("information_schema.columns")) return hasColumn ? [{ "?column?": 1 }] : [];
    if (text.includes("FROM conditions WHERE id = ANY")) return rows;
    if (text.includes("FROM conditions WHERE id = $1")) return [{ id: 5, condition_no: "CL-1", status: "active" }];
    if (text.includes("SET closed_at = NULL")) return [{ id: 5 }];
    return undefined;
  });

test("過去分として完了：まとめて閉じ、完了扱いとは別の種類（archived）で持つ。閉じている・無効は飛ばす", async () => {
  const db = archiveDb([
    { id: 5, condition_no: "CL-5", status: "active", closed_at: null },
    { id: 6, condition_no: "CL-6", status: "active", closed_at: "2026-01-01" },
    { id: 7, condition_no: "CL-7", status: "void", closed_at: null }
  ]);
  const r = await new ConditionWriteService(db).archive([5, 6, 7, 8], "  ", "k");
  assert.deepEqual(r.archived, [5]);
  assert.deepEqual(r.skipped.map((x) => [x.conditionId, x.reason]),
    [[6, "もう閉じています"], [7, "無効・改訂済みの条件"], [8, "条件が見つかりません"]]);
  const up = db.find("closed_kind = 'archived'")!;
  assert.deepEqual(up.params, [[5], "過去分のため検収・支払を追跡しない", "k"], "理由が空なら既定の理由");
  assert.equal(db.all("UPDATE conditions").some((q) => q.text.includes("status =")), false, "状態は触らない");
  assert.equal(db.find("INSERT INTO audit_events")!.params[1], "condition.archive");
});

test("過去分として完了：199 を流していなければ断る。取り消しは種類も空に戻す（列が無ければ触らない）", async () => {
  await assert.rejects(() => new ConditionWriteService(archiveDb([], false)).archive([5], "x", "k"), /199_condition_archived\.sql を先に流してください/);
  await assert.rejects(() => new ConditionWriteService(archiveDb([])).archive([], "x", "k"), /条件を選んでください/);
  const withCol = archiveDb([]);
  await new ConditionWriteService(withCol).reopen(5, "k");
  assert.ok(withCol.find("SET closed_at = NULL")!.text.includes("closed_kind = NULL"));
  const without = archiveDb([], false);
  await new ConditionWriteService(without).reopen(5, "k");
  assert.ok(!without.find("SET closed_at = NULL")!.text.includes("closed_kind"), "列が無い DB でも取り消せる");
});
