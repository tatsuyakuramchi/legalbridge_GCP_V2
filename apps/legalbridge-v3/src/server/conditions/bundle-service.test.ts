import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { ConditionBundleService, SECTION_LABEL } from "./bundle-service.js";
import type { BundlePatch } from "./bundle-service.js";

/**
 * まとめて直す。段ごとの書き込みは持ち主に任せ、断られると分かっているものは
 * 何も書く前に止める（前半だけ書けた状態を作らない）。
 */

const calls: string[] = [];
const parts = (over: Record<string, unknown> = {}) => {
  calls.length = 0;
  return {
    conditions: {
      updateEconomics: async (...a: unknown[]) => {
        calls.push(`condition:${JSON.stringify(a[1])}`);
        return { changed: [], resolvesThrough: [] } as never;
      }
    },
    schedules: {
      replace: async (...a: unknown[]) => { calls.push(`schedules:${(a[1] as unknown[]).length}`); return {} as never; }
    },
    events: {
      amend: async (...a: unknown[]) => {
        calls.push(`event:${JSON.stringify(a[2])}`);
        return { eventId: 9, changed: Object.keys(a[2] as object) };
      }
    },
    payments: {
      amend: async (...a: unknown[]) => {
        calls.push(`payment:${JSON.stringify(a[1])}`);
        return { paymentId: 4, changed: Object.keys(a[1] as object), due: null };
      }
    },
    ...over
  } as never;
};

const db = (over: Record<string, Array<Record<string, unknown>>> = {}) =>
  new FakeDatabase((t) => {
    for (const [fragment, rows] of Object.entries(over)) if (t.includes(fragment)) return rows;
    if (t.includes("FROM conditions WHERE id")) return [{ status: "active" }];
    if (t.includes("FROM condition_events e WHERE e.id")) return [{ status: "active", blocking_no: null }];
    if (t.includes("FROM payments WHERE id")) return [{ status: "planned" }];
    return [];
  });

const patch: BundlePatch = {
  condition: { flatAmount: 120000 },
  schedules: [{ seq: 1, triggerKind: "on_inspection", plannedAmount: 60000 } as never,
              { seq: 2, triggerKind: "on_inspection", plannedAmount: 60000 } as never],
  event: { id: 9, occurredOn: "2026-09-20" },
  payment: { id: 4, dueOn: "2026-10-31" }
};

test("上の段から順に書き、書けた段と欄を返す", async () => {
  const p = parts();
  const r = await new ConditionBundleService(db(), p).apply(3, patch, "納品数の再調整", "admin");
  assert.deepEqual(r.applied.map((a) => a.section), ["condition", "schedules", "event", "payment"]);
  assert.equal(r.stoppedAt, null);
  // 条件 → 予定 → 実績 → 支払 の順。手前を飛ばして先を書かない。
  assert.deepEqual(calls.map((c) => c.split(":")[0]), ["condition", "schedules", "event", "payment"]);
});

test("支払が立っている実績の金額は、何も書く前に止める", async () => {
  // 先に条件だけ書けてしまうと、条件の金額と実績の金額が食い違ったまま残る。
  const p = parts();
  await assert.rejects(
    () => new ConditionBundleService(
      db({ "FROM condition_events e WHERE e.id": [{ status: "active", blocking_no: "PY-2026-0007" }] }), p)
      .apply(3, { ...patch, event: { id: 9, amount: 50000 } }, "訂正", "admin"),
    /支払 PY-2026-0007 が立っています/);
  assert.deepEqual(calls, [], "1つも書いていないこと");
});

test("日付だけなら、支払が立っていても直せる", async () => {
  const p = parts();
  const r = await new ConditionBundleService(
    db({ "FROM condition_events e WHERE e.id": [{ status: "active", blocking_no: "PY-1" }] }), p)
    .apply(3, { event: { id: 9, occurredOn: "2026-09-20" } }, "納品日の訂正", "admin");
  assert.deepEqual(r.applied.map((a) => a.section), ["event"]);
});

test("無効にした条件・実績・支払は、何も書く前に止める", async () => {
  for (const [fragment, rows, message] of [
    ["FROM conditions WHERE id", [{ status: "void" }], /無効にした条件/],
    ["FROM condition_events e WHERE e.id", [{ status: "void" }], /無効にした実績/],
    ["FROM payments WHERE id", [{ status: "canceled" }], /取り消した支払/]
  ] as const) {
    const p = parts();
    await assert.rejects(
      () => new ConditionBundleService(db({ [fragment]: rows as never }), p).apply(3, patch, "訂正", "admin"),
      message);
    assert.deepEqual(calls, [], `${fragment} で止まったのに書いている`);
  }
});

test("途中で断られたら、そこで止めて どこまで書けたかを返す", async () => {
  const p = parts({
    schedules: { replace: async () => { throw new Error("予定の合計が条件の定額と合いません"); } }
  });
  const r = await new ConditionBundleService(db(), p).apply(3, patch, "訂正", "admin");
  assert.deepEqual(r.applied.map((a) => a.section), ["condition"]);
  assert.equal(r.stoppedAt?.section, "schedules");
  assert.match(r.stoppedAt!.message, /予定の合計/);
  // 止まった先（実績・支払）は書かない。
  assert.deepEqual(calls.map((c) => c.split(":")[0]), ["condition"]);
});

test("実績があって版が増えたときは、増えたことを返す（黙らない）", async () => {
  // 打ち間違いを正したつもりで版が増えるのは驚く。画面がそれを言えるようにする。
  const p = parts({
    conditions: { updateEconomics: async () => ({ changed: [], resolvesThrough: [], revisedTo: 822 }) }
  });
  const r = await new ConditionBundleService(db(), p).apply(
    3, { condition: { flatAmount: 13000 } }, "訂正", "admin");
  assert.equal(r.revisedTo, 822);

  const plain = await new ConditionBundleService(db(), parts()).apply(
    3, { condition: { flatAmount: 13000 } }, "訂正", "admin");
  assert.equal(plain.revisedTo, null);
});

test("理由は必須。直す欄が無ければ断る", async () => {
  await assert.rejects(
    () => new ConditionBundleService(db(), parts()).apply(3, patch, "  ", "admin"),
    /直す理由は必須です/);
  await assert.rejects(
    () => new ConditionBundleService(db(), parts()).apply(3, {}, "訂正", "admin"),
    /直す欄がありません/);
});

test("段の名前が全部ある（画面の見出しに使う）", () => {
  for (const key of ["condition", "schedules", "event", "payment"] as const) {
    assert.ok(SECTION_LABEL[key], `${key} の名前が無い`);
  }
});
