import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRoyaltyEventRepository, RoyaltyEventReferenceError } from "./event-repository.js";

test("消化イベントを追記し、条件行ごとにevent_noを連番化する", async () => {
  const repo = new MemoryRoyaltyEventRepository(new Set([1, 2]), new Set([10]));
  const first = await repo.appendRoyaltyCalcEvent({ conditionLineId: 1, documentId: 10, amountExTax: 5000, period: "2026-08" });
  const second = await repo.appendRoyaltyCalcEvent({ conditionLineId: 1, documentId: 10, amountExTax: 3000 });
  const other = await repo.appendRoyaltyCalcEvent({ conditionLineId: 2, documentId: 10, amountExTax: 1000 });
  assert.equal(first.eventNo, 1);
  assert.equal(second.eventNo, 2);      // 同一条件行で連番
  assert.equal(other.eventNo, 1);       // 別条件行は1から
  assert.equal(first.amountExTax, 5000);
  assert.equal(first.period, "2026-08");
  assert.equal(repo.events.length, 3);
});

test("document未指定・未知の条件行/文書は参照エラー", async () => {
  const repo = new MemoryRoyaltyEventRepository(new Set([1]), new Set([10]));
  await assert.rejects(
    () => repo.appendRoyaltyCalcEvent({ conditionLineId: 1, documentId: 0, amountExTax: 100 }),
    RoyaltyEventReferenceError
  );
  await assert.rejects(
    () => repo.appendRoyaltyCalcEvent({ conditionLineId: 99, documentId: 10, amountExTax: 100 }),
    RoyaltyEventReferenceError
  );
  await assert.rejects(
    () => repo.appendRoyaltyCalcEvent({ conditionLineId: 1, documentId: 77, amountExTax: 100 }),
    RoyaltyEventReferenceError
  );
});
