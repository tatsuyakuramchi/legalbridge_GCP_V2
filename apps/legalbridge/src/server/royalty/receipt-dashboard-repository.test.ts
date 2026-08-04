import assert from "node:assert/strict";
import test from "node:test";
import { MemoryReceiptDashboardRepository, summarize, type ReceiptDashboardRow } from "./receipt-dashboard-repository.js";

function row(over: Partial<ReceiptDashboardRow>): ReceiptDashboardRow {
  return {
    id: 1, period: "2026-08", workCode: "W-1", workTitle: "作品A", counterpartyName: "相手方X",
    conditionName: "再許諾", reportedSales: 100000, computedRoyaltyExTax: 10000,
    receivedAmount: 9000, computedDistributionExTax: 2000,
    hasParentLicense: true, received: true, distributed: true, ...over
  };
}

test("3KPIを集計する（受領再許諾料/実受領/分配）", () => {
  const s = summarize([
    row({ id: 1, computedRoyaltyExTax: 10000, receivedAmount: 9000, computedDistributionExTax: 2000 }),
    row({ id: 2, computedRoyaltyExTax: 5000, receivedAmount: null, computedDistributionExTax: 1000 })
  ], 1000);
  assert.equal(s.totalReceiptRoyalty, 15000);
  assert.equal(s.totalReceived, 9000);      // null は0扱い
  assert.equal(s.totalDistribution, 3000);
  assert.equal(s.count, 2);
  assert.equal(s.truncated, false);
});

test("フィルタ：period / 未受領 / 未分配 / フリーワード", async () => {
  const repo = new MemoryReceiptDashboardRepository([
    row({ id: 1, period: "2026-08", workTitle: "空の物語", received: true, distributed: true }),
    row({ id: 2, period: "2026-08", workTitle: "海の詩", received: false, distributed: true }),
    row({ id: 3, period: "2026-07", workTitle: "空の続き", received: true, distributed: false })
  ]);
  assert.equal((await repo.list({ period: "2026-08" })).rows.length, 2);
  assert.equal((await repo.list({ unreceived: true })).rows.length, 1);   // id2
  assert.equal((await repo.list({ undistributed: true })).rows.length, 1); // id3
  const byWord = await repo.list({ q: "空" });
  assert.equal(byWord.rows.length, 2); // id1, id3
});

test("上限でtruncatedを立てる", async () => {
  const repo = new MemoryReceiptDashboardRepository([row({ id: 1 }), row({ id: 2 }), row({ id: 3 })]);
  const result = await repo.list({ limit: 2 });
  assert.equal(result.rows.length, 2);
  assert.equal(result.summary.truncated, true);
});
