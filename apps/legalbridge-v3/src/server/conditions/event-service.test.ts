import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { ConditionEventService } from "./event-service.js";

const input = (over: Record<string, unknown> = {}) => ({
  eventType: "sales" as const, occurredOn: "2026-06-30", amount: 3800000, ...over
});

const db = (over: Record<string, Array<Record<string, unknown>>> = {}) =>
  new FakeDatabase((t) => {
    for (const [fragment, rows] of Object.entries(over)) {
      if (t.includes(fragment)) return rows;
    }
    if (t.includes("SELECT id, status FROM conditions")) return [{ id: 1, status: "active" }];
    if (t.includes("INSERT INTO condition_events")) return [{ id: 9 }];
    return [];
  });

test("総額と控除が実額と合わない記録は受け付けない", async () => {
  const database = db();
  await assert.rejects(
    () => new ConditionEventService(database).add(1,
      input({ grossAmount: 4000000, deductions: 200000, amount: 3000000 }), "a"),
    /3800000 が実額 3000000 と合いません/);
  assert.equal(database.find("INSERT INTO condition_events"), undefined);
});

test("総額と控除が合っていれば記録する", async () => {
  const database = db();
  const r = await new ConditionEventService(database).add(1,
    input({ grossAmount: 4000000, deductions: 200000, amount: 3800000 }), "legal@arch.co.jp");
  assert.equal(r.id, 9);
  const q = database.find("INSERT INTO condition_events")!;
  assert.equal(q.params[7], 4000000);   // gross
  assert.equal(q.params[8], 200000);    // deductions
  assert.equal(q.params[9], 3800000);   // amount
});

test("総額を書かなければ実額だけで記録できる", async () => {
  const database = db();
  await new ConditionEventService(database).add(1, input(), "a");
  const q = database.find("INSERT INTO condition_events")!;
  assert.equal(q.params[7], null, "総額は任意");
  assert.equal(q.params[8], 0);
});

test("旧版・無効の条件には実績を足せない", async () => {
  await assert.rejects(
    () => new ConditionEventService(db({ "SELECT id, status FROM conditions": [{ id: 1, status: "superseded" }] }))
      .add(1, input(), "a"),
    /旧版には実績を足せません/);
  await assert.rejects(
    () => new ConditionEventService(db({ "SELECT id, status FROM conditions": [{ id: 1, status: "void" }] }))
      .add(1, input(), "a"),
    /無効にした条件には実績を足せません/);
});

test("取り消しは記録を消さず、理由を必ず添える", async () => {
  const database = db({ "FROM condition_events e": [{ id: 5, status: "active", amount: 100, document_id: null }] });
  await assert.rejects(
    () => new ConditionEventService(database).void(1, 5, "   ", "a"), /理由は必須/);

  await new ConditionEventService(database).void(1, 5, "入力ミス", "a");
  const q = database.find("UPDATE condition_events")!;
  assert.match(q.text, /status = 'void'/);
  assert.equal(database.all("DELETE FROM condition_events").length, 0, "実績は消さない");
  assert.match(String(q.params[1]), /取消：入力ミス/);
});

test("計算書から作られた実績は取り消せない（片方だけ消すと食い違う）", async () => {
  const database = db({ "FROM condition_events e":
    [{ id: 5, status: "active", amount: 100, document_id: 7, document_no: "ARC-RST-2026-0001" }] });
  await assert.rejects(
    () => new ConditionEventService(database).void(1, 5, "入力ミス", "a"),
    /ARC-RST-2026-0001 から作られています/);
  assert.equal(database.find("UPDATE condition_events"), undefined);
});

test("取り消し済みを二度取り消さない", async () => {
  const database = db({ "FROM condition_events e": [{ id: 5, status: "void", amount: 100, document_id: null }] });
  await assert.rejects(
    () => new ConditionEventService(database).void(1, 5, "重複", "a"), /すでに取り消されて/);
});

test("記録も取消も監査に残す", async () => {
  const database = db();
  await new ConditionEventService(database).add(1, input(), "legal@arch.co.jp");
  assert.equal(database.find("INSERT INTO audit_events")!.params[1], "condition.event_add");
});

// ---- 実績を文書に結びつける ----

const linkDb = (over: Record<string, Array<Record<string, unknown>>> = {}) =>
  new FakeDatabase((t) => {
    for (const [fragment, rows] of Object.entries(over)) {
      if (t.includes(fragment)) return rows;
    }
    if (t.includes("FROM documents WHERE id")) {
      return [{ id: 7, document_no: "ARC-INS-2026-0001", status: "issued" }];
    }
    if (t.includes("FROM condition_events\n            WHERE id = ANY")) {
      return [{ id: 5, status: "active", document_id: null }];
    }
    if (t.includes("UPDATE condition_events SET document_id")) return [{ id: 5 }];
    return [];
  });

test("実績を発行済み文書に結びつけると document_id が入る", async () => {
  const database = linkDb();
  const r = await new ConditionEventService(database).linkDocument(1, [5], 7, "a");
  assert.equal(r.documentNo, "ARC-INS-2026-0001");
  const q = database.find("UPDATE condition_events SET document_id");
  assert.ok(q, "この列にしか「どの文書から出たか」は無い");
  assert.deepEqual(q!.params[0], [5]);
});

test("下書きには結びつけない（捨てられると実績が宙に浮く）", async () => {
  await assert.rejects(
    () => new ConditionEventService(
      linkDb({ "FROM documents WHERE id": [{ id: 7, document_no: null, status: "draft" }] }))
      .linkDocument(1, [5], 7, "a"), /発行済みの文書にだけ/);
});

test("取り消し済みの実績は結びつけない", async () => {
  await assert.rejects(
    () => new ConditionEventService(
      linkDb({ "FROM condition_events\n            WHERE id = ANY":
        [{ id: 5, status: "void", document_id: null }] }))
      .linkDocument(1, [5], 7, "a"), /取り消し済みの実績は/);
});

test("すでに別の文書に出した実績は二重に出さない", async () => {
  await assert.rejects(
    () => new ConditionEventService(
      linkDb({ "FROM condition_events\n            WHERE id = ANY":
        [{ id: 5, status: "active", document_id: "99" }] }))
      .linkDocument(1, [5], 7, "a"), /すでに別の文書に結びついている/);
});

test("同じ文書へならやり直せる（訂正版の発行で実績が先に移ってきた場合）", async () => {
  // bigint は文字列で返る。ここを数値で書いた偽データにしていたせいで、
  // "7" !== 7 で自分の実績まで弾く不具合を取り逃がしていた。
  const database = linkDb({
    "FROM condition_events\n            WHERE id = ANY":
      [{ id: 5, status: "active", document_id: "7" }],
    // UPDATE には document_id IS NULL が付いている。すでに埋まっているので0件。
    "UPDATE condition_events SET document_id": []
  });
  const r = await new ConditionEventService(database).linkDocument(1, [5], 7, "a");
  assert.equal(r.linked, 0, "動かすものが無い");
  assert.ok(database.find("UPDATE condition_events SET document_id"));
  assert.ok(!database.find("INSERT INTO audit_events"),
    "何も動いていないので記録も残さない（linked:0 は失敗と読まれる）");
});

test("この条件に無い実績は混ぜられない", async () => {
  await assert.rejects(
    () => new ConditionEventService(
      linkDb({ "FROM condition_events\n            WHERE id = ANY": [] }))
      .linkDocument(1, [5], 7, "a"), /この条件に無い実績/);
});

/**
 * 外す側。移行してきた文書を実績に結び直す作業では必ず取り違えるので、
 * 直せないと、間違えた瞬間にその実績は二度と正しい文書に結べなくなる。
 */
const unlinkDb = (rowCount = 1) =>
  new FakeDatabase((t) => (t.includes("SET document_id = NULL")
    ? Array.from({ length: rowCount }, (_, i) => ({ id: i + 1 })) : undefined));

test("結びつけを外せる（結び直しの取り違えを直せる）", async () => {
  const db = unlinkDb();
  const r = await new ConditionEventService(db).unlinkDocument(1, [5], 7, "kuramochi");
  assert.equal(r.unlinked, 1);
  const q = db.find("SET document_id = NULL")!;
  assert.deepEqual(q.params, [[5], 1, 7]);
  assert.equal(db.find("INSERT INTO audit_events")!.params[1], "condition.unlink_document");
});

test("外すのは、その文書に結びついている実績だけ", async () => {
  // 番号を取り違えたまま押しても、別の文書の紐づけには手が届かない。
  const q = unlinkDb();
  await new ConditionEventService(q).unlinkDocument(1, [5], 7, "k");
  assert.match(q.find("SET document_id = NULL")!.text, /document_id = \$3/);
});

test("外すものが無ければ、黙って成功しない", async () => {
  // 0件で成功を返すと、画面には「外した」と出るのに何も変わっていない。
  await assert.rejects(
    () => new ConditionEventService(unlinkDb(0)).unlinkDocument(1, [5], 7, "k"),
    /結びついている実績がありません/);
});

test("外す実績を指定しなければ断る", async () => {
  await assert.rejects(
    () => new ConditionEventService(unlinkDb()).unlinkDocument(1, [], 7, "k"),
    /外す実績がありません/);
});

test("結びつけも監査に残す", async () => {
  const database = linkDb();
  await new ConditionEventService(database).linkDocument(1, [5], 7, "legal@arch.co.jp");
  assert.equal(database.find("INSERT INTO audit_events")!.params[1], "condition.link_document");
});

test("実績を条件ごとに分ける。無い実績は止める", async () => {
  const db = new FakeDatabase((t, params) =>
    t.includes("SELECT id, condition_id FROM condition_events")
      ? (params[0] as number[]).filter((i) => i !== 99).map((i) => ({ id: String(i), condition_id: i < 20 ? "1" : "2" }))
      : undefined);
  const svc = new ConditionEventService(db);
  const groups = await svc.groupByCondition([11, 21, 12]);
  assert.deepEqual([...groups.entries()], [[1, [11, 12]], [2, [21]]]);
  await assert.rejects(() => svc.groupByCondition([11, 99]), /実績が見つかりません：99/);
});

/**
 * 実績は2つの入口から作れる（実績の欄で回を選ぶ／予定の行から）。
 * 検収書の支払日は予定から引くので、回に繋がっていない実績は支払日が空になる。
 */
test("回を選べば予定に繋がり、発生日・金額・期間・種類が予定から入る", async () => {
  const database = db({
    "FROM condition_schedules s WHERE s.id": [{
      id: 7, seq: 2, label: "2026年5月分", trigger_kind: "delivery",
      planned_amount: 280000, due_on: "2026-05-31"
    }],
    "SELECT id FROM condition_events WHERE schedule_id": []
  });
  await new ConditionEventService(database).add(1,
    input({ scheduleId: 7, occurredOn: "", period: null, amount: 280000 }), "a");
  const q = database.find("INSERT INTO condition_events")!;
  assert.equal(q.params[1], 7, "回に繋がっている");
  assert.equal(q.params[3], "2026-05-31", "発生日は予定の期日");
  assert.equal(q.params[4], "2026年5月分", "期間は予定の名前");
});

test("回を選んでも、入れた発生日と期間はそのまま残る", async () => {
  const database = db({
    "FROM condition_schedules s WHERE s.id": [{
      id: 7, seq: 2, label: "2026年5月分", trigger_kind: "delivery",
      planned_amount: 280000, due_on: "2026-05-31"
    }],
    "SELECT id FROM condition_events WHERE schedule_id": []
  });
  await new ConditionEventService(database).add(1,
    input({ scheduleId: 7, occurredOn: "2026-06-02", period: "2026年6月に検収" }), "a");
  const q = database.find("INSERT INTO condition_events")!;
  assert.equal(q.params[3], "2026-06-02");
  assert.equal(q.params[4], "2026年6月に検収");
});

test("すでに実績が付いた回は選べない", async () => {
  const database = db({
    "FROM condition_schedules s WHERE s.id": [{
      id: 7, seq: 2, label: null, trigger_kind: "delivery",
      planned_amount: 280000, due_on: "2026-05-31"
    }],
    "SELECT id FROM condition_events WHERE schedule_id": [{ id: 55 }]
  });
  await assert.rejects(
    () => new ConditionEventService(database).add(1, input({ scheduleId: 7 }), "a"),
    /第2回にはすでに実績が付いています/);
  assert.equal(database.find("INSERT INTO condition_events"), undefined);
});

test("他の条件の回は選べない", async () => {
  const database = db({ "FROM condition_schedules s WHERE s.id": [] });
  await assert.rejects(
    () => new ConditionEventService(database).add(1, input({ scheduleId: 7 }), "a"),
    /予定明細 7 が見つかりません/);
});

test("検収書がそのまま使う項目を実績に残す", async () => {
  const database = db();
  await new ConditionEventService(database).add(1, input({
    eventType: "inspection", quantity: 1,
    deliverable: "第2回 キャラクターデザイン一式",
    inspectedOn: "2026-06-01", inspectorDept: "法務", inspectorName: "倉持"
  }), "a");
  const q = database.find("INSERT INTO condition_events")!;
  assert.equal(q.params[5], 1, "数量");
  assert.equal(q.params[12], "第2回 キャラクターデザイン一式");
  assert.equal(q.params[13], "2026-06-01");
  assert.equal(q.params[14], "法務");
  assert.equal(q.params[15], "倉持");
});
