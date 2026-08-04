import assert from "node:assert/strict";
import test from "node:test";
import { MemoryReceiptRepository, ReceiptReferenceError } from "./receipt-repository.js";

function repo() {
  return new MemoryReceiptRepository(new Map([
    [1, { ratePct: 10, unitPrice: 500 }],
    [2, { ratePct: 8, unitPrice: 0 }]
  ]));
}

test("受領記録を作成し、受領再許諾料をサーバ再計算する（非数量）", async () => {
  const r = await repo().create(1, { period: "2026-08", reportedSales: 100000 });
  assert.equal(r.computedRoyaltyExTax, 10000); // 100000 × 10%
  assert.equal(r.status, "reported");           // received_amount 無し
  assert.equal(r.period, "2026-08");
});

test("数量ベース（calcType）は数量×単価×料率で再計算", async () => {
  // line1: 料率10% / 単価500 → 100 × 500 × 10% = 5000
  const r = await repo().create(1, { calcType: "BASE_QTY_RATE", reportedQuantity: 100 });
  assert.equal(r.computedRoyaltyExTax, 5000);
});

test("received_amount があれば status=received", async () => {
  const r = await repo().create(1, { reportedSales: 50000, receivedAmount: 5000 });
  assert.equal(r.status, "received");
  assert.equal(r.receivedAmount, 5000);
});

test("更新は同一条件行の料率で再計算する", async () => {
  const store = repo();
  const created = await store.create(1, { reportedSales: 100000 });
  const updated = await store.update(created.id, { reportedSales: 200000 });
  assert.equal(updated.computedRoyaltyExTax, 20000); // 200000 × 10%
  assert.equal(store.receipts.length, 1);            // 置換（重複しない）
});

test("未知の条件行/受領記録は参照エラー", async () => {
  await assert.rejects(() => repo().create(99, { reportedSales: 1 }), ReceiptReferenceError);
  await assert.rejects(() => repo().update(999, { reportedSales: 1 }), ReceiptReferenceError);
});
