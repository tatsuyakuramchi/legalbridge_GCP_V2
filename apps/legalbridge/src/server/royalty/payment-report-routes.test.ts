import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createPaymentReportRouter } from "./payment-report-routes.js";
import { MemoryPaymentReportRepository } from "./payment-report-repository.js";
import type { PaymentReportInput } from "./payment-report.js";

function app(opts: { role?: string; rows?: PaymentReportInput[] } = {}) {
  const a = express();
  a.use((_req, res, next) => {
    res.locals.currentUser = opts.role
      ? ({ email: "u@example.com", role: opts.role, subject: "u", source: "test" } as never)
      : undefined;
    next();
  });
  a.use("/api/v2", createPaymentReportRouter(new MemoryPaymentReportRepository(opts.rows ?? [])));
  return a;
}

function row(over: Partial<PaymentReportInput>): PaymentReportInput {
  return {
    paymentId: 1, vendorName: "取引先X", vendorCode: "V-1", entityType: "個人",
    vendorWithholdingEnabled: null, invoiceRegistrationNumber: "T1", period: "2026-08",
    currency: "JPY", amountExTax: 100000, taxRatePct: 10, ...over
  };
}

test("admin/legal 以外は403", async () => {
  const res = await request(app({ role: "requester" })).get("/api/v2/payment-report");
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "PAYMENT_REPORT_ROLE_REQUIRED");
});

test("legalは源泉込みの支払報告を取得できる", async () => {
  const res = await request(app({ role: "legal", rows: [row({ entityType: "個人", amountExTax: 100000 })] }))
    .get("/api/v2/payment-report");
  assert.equal(res.status, 200);
  assert.equal(res.body.lines.length, 1);
  assert.equal(res.body.lines[0].withholdingTax, 11231);
  assert.equal(res.body.totals.netTransfer, 98769);
});

test("periodで絞り込む", async () => {
  const res = await request(app({ role: "admin", rows: [row({ paymentId: 1, period: "2026-08" }), row({ paymentId: 2, period: "2026-07" })] }))
    .get("/api/v2/payment-report?period=2026-08");
  assert.equal(res.status, 200);
  assert.equal(res.body.lines.length, 1);
});

test("不正なperiodは400", async () => {
  const res = await request(app({ role: "legal" })).get("/api/v2/payment-report?period=2026");
  assert.equal(res.status, 400);
});
