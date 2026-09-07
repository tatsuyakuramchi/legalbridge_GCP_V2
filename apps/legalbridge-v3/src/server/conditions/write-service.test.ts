import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { ConditionWriteService } from "./write-service.js";
import { DomainError } from "../core/errors.js";

const baseRows = (over: { status?: string; events?: number } = {}) =>
  (text: string): Array<Record<string, unknown>> | undefined => {
    if (text.includes("FROM conditions WHERE id = $1 FOR UPDATE")) {
      return [{ id: 1, condition_no: "CL-2026-00042", status: over.status ?? "active",
                counterparty_id: 3, currency: "JPY" }];
    }
    if (text.includes("FROM parties WHERE id = $1")) return [{ id: 9, name: "新しい取引先" }];
    if (text.includes("count(*)::int AS n FROM condition_events")) return [{ n: over.events ?? 0 }];
    if (text.includes("AS documents")) {
      return [{ documents: 3, payments: 1, matters: 1, children: 0 }];
    }
    if (text.includes("INSERT INTO conditions")) return [{ id: 77 }];
    if (text.includes("UPDATE conditions")) return [{ id: 1 }];
    return undefined;
  };

test("相手先の変更は1行だけ書き、参照で追随するものを別建てで返す", async () => {
  const db = new FakeDatabase(baseRows());
  const result = await new ConditionWriteService(db).changeCounterparty(1, 9, "tester");

  const updates = db.all("UPDATE conditions SET counterparty_id");
  assert.equal(updates.length, 1, "書込は1文だけ");
  assert.deepEqual(result.changed, [{ target: "conditions.counterparty_id", rows: 1 }]);
  // 文書・支払・案件は書き換えていない
  assert.equal(db.all("UPDATE documents").length, 0);
  assert.equal(db.all("UPDATE payments").length, 0);
  assert.deepEqual(result.resolvesThrough.map((r) => r.target), [
    "この条件を出力した文書", "この条件に割り当てた支払", "この条件を参照する案件"
  ]);
  assert.ok(db.find("INSERT INTO audit_events"), "監査記録を残す");
  assert.ok(db.texts.includes("COMMIT"), "コミットする");
});

test("実績が無い条件は、金額をその場で書き換えられる（V2 に無かった経路）", async () => {
  const db = new FakeDatabase(baseRows({ events: 0 }));
  const result = await new ConditionWriteService(db)
    .updateEconomics(1, { mgAmount: 1500000, ratePpm: 150000 }, "tester");

  const update = db.find("UPDATE conditions SET mg_amount");
  assert.ok(update, "その場で更新する");
  assert.deepEqual(update!.params, [1, 1500000, 150000]);
  assert.equal(result.revisedTo, undefined);
  assert.equal(db.all("INSERT INTO conditions").length, 0, "改訂行は作らない");
});

test("実績がある条件は改訂になり、旧版は superseded として残る", async () => {
  const db = new FakeDatabase(baseRows({ events: 2 }));
  const result = await new ConditionWriteService(db)
    .updateEconomics(1, { mgAmount: 1500000 }, "tester");

  assert.equal(result.revisedTo, 77);
  assert.ok(db.find("INSERT INTO conditions"), "新版を作る");
  const supersede = db.find("SET status = 'superseded'");
  assert.ok(supersede, "旧版を superseded にする");
  assert.deepEqual(supersede!.params, [1, 77]);
  assert.ok(db.find("INSERT INTO condition_scopes"), "範囲も引き継ぐ");
  const audit = db.find("INSERT INTO audit_events");
  assert.ok(String(audit!.params[1]).includes("revise"));
});

test("旧版と無効の条件は編集を受け付けない", async () => {
  for (const status of ["superseded", "void"]) {
    const db = new FakeDatabase(baseRows({ status }));
    await assert.rejects(
      () => new ConditionWriteService(db).updateEconomics(1, { mgAmount: 1 }, "tester"),
      (error: unknown) => error instanceof DomainError && error.code === "CONFLICT"
    );
    assert.ok(db.texts.includes("ROLLBACK"), "失敗したらロールバックする");
  }
});

test("変更する項目が空なら弾く", async () => {
  const db = new FakeDatabase(baseRows());
  await assert.rejects(
    () => new ConditionWriteService(db).updateEconomics(1, {}, "tester"),
    (error: unknown) => error instanceof DomainError && error.code === "VALIDATION"
  );
});

test("範囲の置き換えは削除してから入れ直す", async () => {
  const db = new FakeDatabase(baseRows());
  const result = await new ConditionWriteService(db).replaceScopes(1, [
    { scopeType: "region", label: "台湾", code: "TW" },
    { scopeType: "region", label: "  ", code: null },
    { scopeType: "language", label: "繁体字中国語", code: null }
  ], "tester");

  assert.ok(db.find("DELETE FROM condition_scopes"));
  assert.equal(db.all("INSERT INTO condition_scopes").length, 2, "空ラベルは捨てる");
  assert.equal(result.changed[0].target, "condition_scopes");
});

test("権限不足（42501）は機能縮退できる形の DomainError に変換する", async () => {
  const db = new FakeDatabase(() => { throw Object.assign(new Error("denied"), { code: "42501" }); });
  await assert.rejects(
    () => new ConditionWriteService(db).changeCounterparty(1, 9, "tester"),
    (error: unknown) => error instanceof DomainError && error.code === "DB_FORBIDDEN"
  );
});
