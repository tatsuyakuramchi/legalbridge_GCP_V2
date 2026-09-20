import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { PaymentAllocationService } from "./allocation-service.js";

const payment = { id: 1, amount: 1_000_000, currency: "JPY", party_id: 5, direction: "in" };
const cond = (id: number, over: Record<string, unknown> = {}) => ({
  id, currency: "JPY", status: "active", party_resolved: 5, series_id: id, ...over
});
const ev = (id: number, seriesId: number, over: Record<string, unknown> = {}) => ({
  id, series_id: seriesId, status: "active", ...over
});

const build = (conds: any[], events: any[] = [ev(1, 10), ev(2, 10)]) => new FakeDatabase((t) => {
  if (t.includes("FROM payments WHERE id")) return [payment];
  // 実績の確かめ（WHERE e.id = ANY）を条件の問い合わせより先に見る。
  // 後ろに置くと c.id = ANY と取り違える。
  if (t.includes("WHERE e.id = ANY")) return events;
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

test("指した実績が別の条件のものなら受け付けない。二重払いの見張りがすり抜ける", async () => {
  const db = build([cond(10)], [ev(7, 99)]);
  await assert.rejects(
    () => new PaymentAllocationService(db).replace(1, [
      { conditionId: 10, eventId: 7, amount: 100 }
    ], "k"), /実績 7 は条件 10 の実績ではありません/);
});

test("無効になった実績は指せない", async () => {
  const db = build([cond(10)], [ev(7, 10, { status: "void" })]);
  await assert.rejects(
    () => new PaymentAllocationService(db).replace(1, [
      { conditionId: 10, eventId: 7, amount: 100 }
    ], "k"), /実績 7 は無効です/);
});

test("無い実績は指せない", async () => {
  const db = build([cond(10)], []);
  await assert.rejects(
    () => new PaymentAllocationService(db).replace(1, [
      { conditionId: 10, eventId: 7, amount: 100 }
    ], "k"), /実績 7 が見つかりません/);
});

test("旧版に付いた実績を、改訂版の条件へ割り当てられる", async () => {
  // 条件 11 は 10 の改訂版（同じ系列）。実績は旧版 10 に付いたまま。
  // ここを弾くと、版を上げた条件は実績を指せなくなる。
  const db = build([cond(11, { series_id: 10 })], [ev(183, 10)]);
  const r = await new PaymentAllocationService(db).replace(1, [
    { conditionId: 11, eventId: 183, amount: 24375 }
  ], "k");
  assert.equal(r.allocated, 24375);
});

test("候補の実績は版をまたいで拾う。旧版の実績が出ないと付け替えられない", async () => {
  const db = new FakeDatabase((t) => {
    if (t.includes("FROM payments y")) {
      return [{
        id: 11, condition_no: "CL-2026-00649-R2", name: "本", direction: "out",
        currency: "JPY", flat_amount: 24375, series_id: 10,
        already_allocated: 24375, allocated_here: 24375
      }];
    }
    if (t.includes("FROM condition_events e")) {
      return [
        // 旧版（系列 10）に付いたままの実績と、改訂版で作り直した実績。
        { id: 183, series_id: 10, occurred_on: "2026-09-30", amount: 24375, document_no: null, picked: true },
        { id: 185, series_id: 10, occurred_on: "2026-09-18", amount: 24375, document_no: "ARC-INS-2026-1022", picked: false }
      ];
    }
    return undefined;
  });
  const [c] = await new PaymentAllocationService(db).candidates(1);
  assert.equal(c.events.length, 2, "旧版の実績も候補に出す");
  assert.deepEqual(c.events.map((e) => e.id), [183, 185]);
  assert.equal(c.allocatedHere, 24375,
    "条件番号の一致で探さなくても初期値が入る。空で保存して割当が消えるのを防ぐ");
});
