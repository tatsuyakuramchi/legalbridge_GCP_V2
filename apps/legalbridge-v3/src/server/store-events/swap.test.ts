import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { swapStoreEventConditions } from "./swap.js";

test("決定で入れ替える：新は下書き → 有効、元は無効（備考に理由）", async () => {
  const db = new FakeDatabase((text, params) => {
    if (text.includes("SELECT manual_inputs")) return [{ manual_inputs: { _storeEvent: { newConditionIds: [200, 201], replacesConditionIds: [50, 51] } } }];
    if (text.includes("SET status = 'active'")) return (params[0] as number[]).map((id) => ({ id }));
    if (text.includes("SET status = 'void'")) return (params[0] as number[]).map((id) => ({ id }));
    return undefined;
  });
  const r = await swapStoreEventConditions(db, 950, "ARC-PO-2026-1165-R2", "ARC-PO-2026-1165", "tester");
  assert.deepEqual(r, { activated: [200, 201], voided: [50, 51] });
  assert.match(String(db.find("SET status = 'void'")!.params[1]), /ARC-PO-2026-1165 の訂正版 ARC-PO-2026-1165-R2/);
  assert.ok(db.find("INSERT INTO audit_events") || db.queries.length >= 4);
});

test("控えの無い訂正版には何もしない", async () => {
  const db = new FakeDatabase((text) => (text.includes("SELECT manual_inputs") ? [{ manual_inputs: { items: [] } }] : undefined));
  const r = await swapStoreEventConditions(db, 950, "X-R2", "X", "tester");
  assert.deepEqual(r, { activated: [], voided: [] });
  assert.equal(db.queries.length, 1);
});
