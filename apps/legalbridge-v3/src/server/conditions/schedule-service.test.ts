import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { ConditionScheduleService, generateLines } from "./schedule-service.js";

const gen = (over: Record<string, unknown> = {}) => generateLines({
  startOn: "2026-04-30", count: 12, everyMonths: 1,
  amount: 280000, triggerKind: "periodic", ...over
} as any);

test("毎月28万円の1年契約は12行になる", () => {
  const lines = gen();
  assert.equal(lines.length, 12);
  assert.equal(lines.reduce((s, l) => s + l.plannedAmount, 0), 3_360_000);
  assert.deepEqual(lines.map((l) => l.seq), Array.from({ length: 12 }, (_, i) => i + 1));
});

test("月末開始なら以降も月末で揃える（翌月末払いの契約）", () => {
  // 4/30 開始が 5/30・6/30 になると、毎月ずれた期日が並ぶ。
  assert.deepEqual(gen({ count: 4 }).map((l) => l.dueOn),
    ["2026-04-30", "2026-05-31", "2026-06-30", "2026-07-31"]);
});

test("2月をまたいでも月末に寄る", () => {
  assert.deepEqual(gen({ startOn: "2026-12-31", count: 4 }).map((l) => l.dueOn),
    ["2026-12-31", "2027-01-31", "2027-02-28", "2027-03-31"]);
});

test("月末でない開始日は、その日を保つ", () => {
  assert.deepEqual(gen({ startOn: "2026-04-15", count: 3 }).map((l) => l.dueOn),
    ["2026-04-15", "2026-05-15", "2026-06-15"]);
});

test("その月に無い日は末日へ寄せる（31日開始の2月）", () => {
  assert.deepEqual(gen({ startOn: "2026-01-31", count: 3 }).map((l) => l.dueOn),
    ["2026-01-31", "2026-02-28", "2026-03-31"]);
});

test("四半期ごとにもできる", () => {
  assert.deepEqual(gen({ startOn: "2026-06-30", count: 4, everyMonths: 3 }).map((l) => l.dueOn),
    ["2026-06-30", "2026-09-30", "2026-12-31", "2027-03-31"]);
});

test("名前は「2026年4月分」の形にする", () => {
  assert.deepEqual(gen({ count: 2 }).map((l) => l.label), ["2026年4月分", "2026年5月分"]);
});

test("回数の上限を超える指定は受け付けない", () => {
  assert.throws(() => gen({ count: 0 }), /1〜120/);
  assert.throws(() => gen({ count: 121 }), /1〜120/);
  assert.throws(() => gen({ startOn: "だめ" }), /読み取れません/);
});

// ---- 保存 ----

const line = (seq: number, over: Record<string, unknown> = {}) => ({
  seq, label: `${seq}回目`, triggerKind: "periodic" as const,
  plannedAmount: 280000, dueOn: "2026-04-30", ...over
});

const db = (over: Record<string, Array<Record<string, unknown>>> = {}) =>
  new FakeDatabase((t) => {
    for (const [fragment, rows] of Object.entries(over)) {
      if (t.includes(fragment)) return rows;
    }
    if (t.includes("SELECT id, status FROM conditions")) return [{ id: 1, status: "active" }];
    if (t.includes("UPDATE condition_schedules")) return [];
    return [];
  });

test("実績が付いている明細は外せない", async () => {
  const database = db({ "EXISTS (SELECT 1 FROM condition_events": [{ id: 5, seq: 1, label: "4月分" }] });
  await assert.rejects(
    () => new ConditionScheduleService(database).replace(1, [line(2)], "a"),
    /実績が付いている明細は外せません（第1回）/);
  assert.equal(database.find("DELETE FROM condition_schedules"), undefined);
});

test("実績が付いた行を残したまま金額は直せる", async () => {
  const database = db({ "EXISTS (SELECT 1 FROM condition_events": [{ id: 5, seq: 1 }] });
  await new ConditionScheduleService(database).replace(1, [line(1, { plannedAmount: 300000 })], "a");
  assert.ok(database.find("UPDATE condition_schedules"));
});

test("ON CONFLICT は使わない（seq の一意制約が DEFERRABLE のため）", async () => {
  const database = db();
  await new ConditionScheduleService(database).replace(1, [line(1)], "a");
  // 監査記録の ON CONFLICT は別（idempotency_key は遅延可能ではない）。
  const onSchedules = database.all("condition_schedules").filter((q) => q.text.includes("ON CONFLICT"));
  assert.equal(onSchedules.length, 0,
    "遅延可能な制約は ON CONFLICT の調停に使えない（PostgreSQL 55000）");
  assert.ok(database.find("UPDATE condition_schedules"), "更新してみて");
  assert.ok(database.find("INSERT INTO condition_schedules"), "無ければ挿す");
});

test("番号の重複と0円は受け付けない", async () => {
  const s = new ConditionScheduleService(db());
  await assert.rejects(() => s.replace(1, [line(1), line(1)], "a"), /番号が重複/);
  await assert.rejects(() => s.replace(1, [line(1, { plannedAmount: 0 })], "a"), /0円以下/);
});

test("旧版・無効の条件の明細は変えられない", async () => {
  await assert.rejects(
    () => new ConditionScheduleService(db({ "SELECT id, status FROM conditions": [{ status: "superseded" }] }))
      .replace(1, [line(1)], "a"), /旧版の明細は変えられません/);
});
