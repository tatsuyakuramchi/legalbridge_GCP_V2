import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { ConditionWriteService } from "./write-service.js";
import { DomainError } from "../core/errors.js";

const baseRows = (
  over: { status?: string; events?: number; pending?: Array<Record<string, unknown>> } = {}
) =>
  (text: string): Array<Record<string, unknown>> | undefined => {
    if (text.includes("FROM conditions WHERE id = $1 FOR UPDATE")) {
      return [{ id: 1, condition_no: "CL-2026-00042", status: over.status ?? "active",
                counterparty_id: 3, currency: "JPY", series_id: 1, effective_from: "2026-04-01" }];
    }
    if (text.includes("FROM parties WHERE id = $1")) return [{ id: 9, name: "新しい取引先" }];
    if (text.includes("count(*)::int AS n FROM condition_events")) return [{ n: over.events ?? 0 }];
    if (text.includes("SELECT current_date AS d")) return [{ d: "2026-09-08" }];
    if (text.includes("status = 'scheduled' AND id <> $2")) return over.pending ?? [];
    if (text.includes("UPDATE condition_schedules s")) return [];
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

// ---- 契約変更の適用開始日 ----

const FUTURE = "2027-04-01";

test("未来の適用開始日を渡すと、いまの版は生きたまま予約の版ができる", async () => {
  const db = new FakeDatabase(baseRows({ events: 3 }));
  const r = await new ConditionWriteService(db)
    .updateEconomics(1, { ratePpm: 150000 }, "tester", FUTURE);

  const insert = db.find("INSERT INTO conditions")!;
  assert.match(insert.text, /'scheduled'|\$\d+ FROM conditions/, "新版を挿す");
  assert.ok(insert.params.includes("scheduled"), "予約の版として置く");
  assert.ok(insert.params.includes(FUTURE), "適用開始日を持たせる");
  // 旧版は superseded にしない。active が2行あると集計が二重になるので
  // 新版のほうを scheduled にして避ける。
  assert.equal(db.find("SET status = 'superseded'"), undefined,
    "適用日が来るまで、いまの版が効いたままでなければならない");
  assert.equal(r.revisedTo, 77);
});

test("適用開始日が今日以前なら、これまでどおり即座に切り替わる", async () => {
  const db = new FakeDatabase(baseRows({ events: 3 }));
  await new ConditionWriteService(db).updateEconomics(1, { ratePpm: 150000 }, "tester", "2026-01-01");
  assert.ok(db.find("SET status = 'superseded'"), "旧版はその場で差し替え済みになる");
});

test("適用開始日を省いても、新版は今日から適用として記録する", async () => {
  const db = new FakeDatabase(baseRows({ events: 3 }));
  await new ConditionWriteService(db).updateEconomics(1, { ratePpm: 150000 }, "tester");
  const insert = db.find("INSERT INTO conditions")!;
  assert.match(insert.text, /current_date/,
    "JS の時計ではなく SQL の current_date（時差で1日ずれる）");
});

test("予約は系列に1つだけ。二重に入れさせない", async () => {
  const db = new FakeDatabase(baseRows({
    events: 3, pending: [{ id: 55, condition_no: "CL-R2", effective_from: "2027-01-01" }] }));
  await assert.rejects(
    () => new ConditionWriteService(db).updateEconomics(1, { ratePpm: 150000 }, "tester", FUTURE),
    /すでに 2027-01-01 適用の改訂が予定されています/);
  assert.equal(db.find("INSERT INTO conditions"), undefined);
});

test("予約そのものを直すときは、版を増やさず上書きする", async () => {
  const db = new FakeDatabase(baseRows({ status: "scheduled", events: 0 }));
  await new ConditionWriteService(db).updateEconomics(1, { ratePpm: 160000 }, "tester", FUTURE);
  assert.equal(db.find("INSERT INTO conditions"), undefined, "まだ効いていないので版は増やさない");
  const update = db.find("UPDATE conditions SET")!;
  assert.ok(update.params.includes(FUTURE));
});

test("改訂は予定明細を新版へ引き継ぐ（写さずに移す）", async () => {
  const db = new FakeDatabase(baseRows({ events: 3 }));
  await new ConditionWriteService(db).updateEconomics(1, { flatAmount: 300000 }, "tester", FUTURE);
  const carry = db.find("UPDATE condition_schedules s")!;
  assert.ok(carry, "引き継がないと、12回分の予定が改訂で消える");
  assert.match(carry.text, /SET condition_id = \$2/, "両方の版に残すと予定の合計が二重になる");
  assert.match(carry.text, /due_on >= \$3::date/, "適用日より前の回は旧版のまま");
  assert.match(carry.text, /NOT EXISTS \(SELECT 1 FROM condition_events/,
    "実績が付いた回は動かさない");
});

test("改訂は系列を引き継ぐ", async () => {
  const db = new FakeDatabase(baseRows({ events: 3 }));
  await new ConditionWriteService(db).updateEconomics(1, { ratePpm: 150000 }, "tester");
  assert.match(db.find("INSERT INTO conditions")!.text, /series_id/,
    "系列が切れると AG の消化累計が版ごとに分かれる");
});
