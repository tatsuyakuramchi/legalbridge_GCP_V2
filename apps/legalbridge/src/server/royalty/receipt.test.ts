import assert from "node:assert/strict";
import test from "node:test";
import { isQtyBased, computeReceiptRoyalty, resolveDistribution } from "./receipt.js";

test("数量ベース判定：calc_type or basis=manufacturing", () => {
  assert.equal(isQtyBased({ calcType: "BASE_QTY_RATE" }), true);
  assert.equal(isQtyBased({ calcType: "supply_qty" }), true);   // 大小無視
  assert.equal(isQtyBased({ basis: "manufacturing" }), true);
  assert.equal(isQtyBased({ calcType: "BASE_RATE" }), false);
  assert.equal(isQtyBased({}), false);
});

test("受領再許諾料：数量ベース=数量×単価×料率、非数量=売上×料率", () => {
  // 数量ベース：100 × 500 × 8% = 4000
  assert.equal(
    computeReceiptRoyalty({ calcType: "BASE_QTY_RATE", unitPrice: 500, ratePct: 8 }, { reportedQuantity: 100 }),
    4000
  );
  // 非数量：123456 × 7% = 8641.92（小数2桁）
  assert.equal(
    computeReceiptRoyalty({ calcType: "BASE_RATE", ratePct: 7 }, { reportedSales: 123456 }),
    8641.92
  );
  // 料率0・未入力は0
  assert.equal(computeReceiptRoyalty({ ratePct: 0 }, { reportedSales: 1000 }), 0);
});

test("分配：数量ベースは単価×報告数量、親料率で算定", () => {
  const r = resolveDistribution({
    cond: { calcType: "BASE_QTY_RATE", unitPrice: 500 },
    report: { reportedQuantity: 100 },
    parentRatePct: 10
  });
  assert.equal(r.base, 500);   // 単価
  assert.equal(r.qty, 100);    // 報告数量
  assert.equal(r.distribution, 5000); // 500×100×10%
});

test("分配：権利許諾は受領再許諾料×1、親料率で算定", () => {
  const r = resolveDistribution({
    cond: { calcType: "BASE_RATE" },
    report: {},
    computedRoyaltyExTax: 4000,
    parentRatePct: 20
  });
  assert.equal(r.base, 4000);
  assert.equal(r.qty, 1);
  assert.equal(r.distribution, 800); // 4000×1×20%
});

test("分配：基準額/個数の手動上書き、小数2桁round", () => {
  const r = resolveDistribution({
    cond: { calcType: "BASE_RATE" },
    report: {},
    parentRatePct: 15,
    baseOverride: 333,
    qtyOverride: 1
  });
  assert.equal(r.base, 333);
  assert.equal(r.distribution, 49.95); // 333×1×15%
});

test("分配：親料率不明なら分配額はnull（基準額/個数は算定）", () => {
  const r = resolveDistribution({
    cond: { calcType: "BASE_QTY_RATE", unitPrice: 200 },
    report: { reportedQuantity: 3 },
    parentRatePct: null
  });
  assert.equal(r.base, 200);
  assert.equal(r.qty, 3);
  assert.equal(r.distribution, null);
});
