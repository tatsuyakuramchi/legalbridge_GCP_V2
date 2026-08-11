import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createReceiptDashboardRouter } from "./receipt-dashboard-routes.js";
import { MemoryReceiptDashboardRepository, type ReceiptDashboardRow } from "./receipt-dashboard-repository.js";

function row(over: Partial<ReceiptDashboardRow>): ReceiptDashboardRow {
  return {
    id: 1, conditionLineId: 501, period: "2026-08", workCode: "W-1", workTitle: "作品A", counterpartyName: "相手方X",
    conditionName: "再許諾", reportedSales: 100000, computedRoyaltyExTax: 10000,
    receivedAmount: 9000, computedDistributionExTax: 2000,
    hasParentLicense: true, received: true, distributed: true, ...over
  };
}

function app(opts: { role?: string; rows?: ReceiptDashboardRow[] } = {}) {
  const a = express();
  a.use((_req, res, next) => {
    res.locals.currentUser = opts.role
      ? ({ email: "u@example.com", role: opts.role, subject: "u", source: "test" } as never)
      : undefined;
    next();
  });
  a.use("/api/v2", createReceiptDashboardRouter(new MemoryReceiptDashboardRepository(opts.rows ?? [])));
  return a;
}

test("admin/legal 以外は403", async () => {
  const res = await request(app({ role: "requester" })).get("/api/v2/receipts-dashboard");
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "RECEIPTS_DASHBOARD_ROLE_REQUIRED");
});

test("legalは一覧とKPIを取得できる", async () => {
  const res = await request(app({ role: "legal", rows: [row({ id: 1 }), row({ id: 2, computedRoyaltyExTax: 5000, receivedAmount: null })] }))
    .get("/api/v2/receipts-dashboard");
  assert.equal(res.status, 200);
  assert.equal(res.body.rows.length, 2);
  assert.equal(res.body.summary.totalReceiptRoyalty, 15000);
  assert.equal(res.body.summary.totalReceived, 9000);
});

test("フィルタ（未受領）をクエリで受け付ける", async () => {
  const res = await request(app({ role: "admin", rows: [row({ id: 1, received: true }), row({ id: 2, received: false })] }))
    .get("/api/v2/receipts-dashboard?unreceived=true");
  assert.equal(res.status, 200);
  assert.equal(res.body.rows.length, 1);
});

test("不正なperiodは400", async () => {
  const res = await request(app({ role: "legal" })).get("/api/v2/receipts-dashboard?period=2026");
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "invalid request");
});
