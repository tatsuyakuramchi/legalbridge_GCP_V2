import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { PaymentAllocationService } from "./allocation-service.js";

const payment = { id: 1, amount: 1_000_000, currency: "JPY", party_id: 5, direction: "in" };
const cond = (id: number, over: Record<string, unknown> = {}) => ({
  id, currency: "JPY", status: "active", party_resolved: 5, ...over
});

const build = (conds: any[]) => new FakeDatabase((t) => {
  if (t.includes("FROM payments WHERE id")) return [payment];
  if (t.includes("FROM conditions c\n         JOIN v_party_resolved") || t.includes("c.id = ANY")) return conds;
  if (t.includes("FROM v_party_resolved WHERE party_id")) return [{ resolved_id: 5 }];
  if (t.includes("FROM payment_allocations al JOIN conditions")) {
    return [{ condition_id: 10, amount: 600000, condition_no: "CL-10" }];
  }
  return undefined;
});

test("割り当てを置き換え、未割当の残りを返す", async () => {
  const db = build([cond(10)]);
  const r = await new PaymentAllocationService(db).replace(1, [{ conditionId: 10, amount: 600000 }], "k");
  assert.equal(r.allocated, 600000);
  assert.equal(r.unallocated, 400000, "支払額との差を隠さない");
  assert.ok(db.queries.some((q) => q.text.includes("DELETE FROM payment_allocations")),
    "差分ではなく全体を置き換える");
});

test("支払額を超える割り当ては受け付けない", async () => {
  const db = build([cond(10)]);
  await assert.rejects(
    () => new PaymentAllocationService(db).replace(1, [{ conditionId: 10, amount: 1_500_000 }], "k"),
    /支払額 1000000 を超えています/);
});

test("0円の割り当ては置けない", async () => {
  const db = build([cond(10)]);
  await assert.rejects(
    () => new PaymentAllocationService(db).replace(1, [{ conditionId: 10, amount: 0 }], "k"),
    /0円の割り当ては置けません/);
});

test("同じ条件・実績への重複を弾く", async () => {
  const db = build([cond(10)]);
  await assert.rejects(
    () => new PaymentAllocationService(db).replace(1, [
      { conditionId: 10, amount: 100 }, { conditionId: 10, amount: 200 }
    ], "k"), /重複しています/);
});

test("実績が違えば同じ条件に複数置ける", async () => {
  const db = build([cond(10)]);
  const r = await new PaymentAllocationService(db).replace(1, [
    { conditionId: 10, eventId: 1, amount: 100000 },
    { conditionId: 10, eventId: 2, amount: 200000 }
  ], "k");
  assert.equal(r.allocated, 300000);
});

test("通貨が違う条件には割り当てない", async () => {
  const db = build([cond(10, { currency: "USD" })]);
  await assert.rejects(
    () => new PaymentAllocationService(db).replace(1, [{ conditionId: 10, amount: 100 }], "k"),
    /通貨（USD）が支払（JPY）と違います/);
});

test("相手先が違う条件には割り当てない。別人の支払で消化されてしまう", async () => {
  const db = build([cond(10, { party_resolved: 99 })]);
  await assert.rejects(
    () => new PaymentAllocationService(db).replace(1, [{ conditionId: 10, amount: 100 }], "k"),
    /相手先が支払の相手先と違います/);
});

test("無効な条件には割り当てない", async () => {
  const db = build([cond(10, { status: "void" })]);
  await assert.rejects(
    () => new PaymentAllocationService(db).replace(1, [{ conditionId: 10, amount: 100 }], "k"),
    /有効な条件にだけ/);
});

test("空で置き換えれば割り当てを外せる", async () => {
  const db = new FakeDatabase((t) => {
    if (t.includes("FROM payments WHERE id")) return [payment];
    return [];
  });
  const r = await new PaymentAllocationService(db).replace(1, [], "k");
  assert.equal(r.allocated, 0);
  assert.equal(r.unallocated, 1_000_000);
});
