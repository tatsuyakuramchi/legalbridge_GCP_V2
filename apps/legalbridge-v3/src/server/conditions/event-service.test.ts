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
  assert.equal(q.params[6], 4000000);   // gross
  assert.equal(q.params[7], 200000);    // deductions
  assert.equal(q.params[8], 3800000);   // amount
});

test("総額を書かなければ実額だけで記録できる", async () => {
  const database = db();
  await new ConditionEventService(database).add(1, input(), "a");
  const q = database.find("INSERT INTO condition_events")!;
  assert.equal(q.params[6], null, "総額は任意");
  assert.equal(q.params[7], 0);
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

test("結びつけも監査に残す", async () => {
  const database = linkDb();
  await new ConditionEventService(database).linkDocument(1, [5], 7, "legal@arch.co.jp");
  assert.equal(database.find("INSERT INTO audit_events")!.params[1], "condition.link_document");
});
