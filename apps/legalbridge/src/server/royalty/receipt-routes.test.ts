import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createReceiptRouter } from "./receipt-routes.js";
import { MemoryReceiptRepository } from "./receipt-repository.js";

function app(opts: { writeEnabled?: boolean; role?: string; syncPayments?: boolean; repo?: MemoryReceiptRepository } = {}) {
  const a = express();
  a.use(express.json());
  a.use((_req, res, next) => {
    res.locals.currentUser = opts.role
      ? ({ email: "u@example.com", role: opts.role, subject: "u", source: "test" } as never)
      : undefined;
    next();
  });
  const repository = opts.writeEnabled
    ? (opts.repo ?? new MemoryReceiptRepository(new Map([[1, {
        ratePct: 10, unitPrice: 500, parentLicenseConditionId: 91, parentRatePct: 20,
        sourceWorkId: 42, counterpartyVendorId: 18, currency: "JPY",
        parentCounterpartyVendorId: 9, parentCurrency: "JPY"
      }]])))
    : undefined;
  a.use("/api/v2", createReceiptRouter(repository, opts.writeEnabled ?? false, opts.syncPayments ?? false));
  return a;
}

const validBody = {
  confirmation: "COMMIT_PRODUCTION_RECEIPT",
  conditionLineId: 1,
  period: "2026-08",
  reportedSales: 100000
};

test("既定OFFは503", async () => {
  const res = await request(app({ role: "legal" })).post("/api/v2/condition-receipts").send(validBody);
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "RECEIPT_STORAGE_UNAVAILABLE");
});

test("admin/legal 以外は403", async () => {
  const res = await request(app({ writeEnabled: true, role: "requester" })).post("/api/v2/condition-receipts").send(validBody);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "RECEIPT_ROLE_REQUIRED");
});

test("確認トークン不一致は400", async () => {
  const res = await request(app({ writeEnabled: true, role: "legal" }))
    .post("/api/v2/condition-receipts").send({ ...validBody, confirmation: "WRONG" });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "RECEIPT_CONFIRMATION_REQUIRED");
});

test("正常系：受領記録を作成し受領再許諾料を再計算", async () => {
  const res = await request(app({ writeEnabled: true, role: "legal" })).post("/api/v2/condition-receipts").send(validBody);
  assert.equal(res.status, 201);
  assert.equal(res.body.receipt.computedRoyaltyExTax, 10000); // 100000 × 10%
  assert.equal(res.body.receipt.status, "reported");
});

test("更新：PUTで再計算する", async () => {
  const a = app({ writeEnabled: true, role: "admin" });
  const created = await request(a).post("/api/v2/condition-receipts").send(validBody);
  const rid = created.body.receipt.id;
  const res = await request(a).put(`/api/v2/condition-receipts/${rid}`)
    .send({ confirmation: "COMMIT_PRODUCTION_RECEIPT", reportedSales: 250000, receivedAmount: 20000 });
  assert.equal(res.status, 200);
  assert.equal(res.body.receipt.computedRoyaltyExTax, 25000); // 250000 × 10%
  assert.equal(res.body.receipt.status, "received");
});

test("payments同期無効時は台帳同期しない（paymentsSynced=0）", async () => {
  const res = await request(app({ writeEnabled: true, role: "legal", syncPayments: false }))
    .post("/api/v2/condition-receipts").send({ ...validBody, receivedAmount: 9000 });
  assert.equal(res.status, 201);
  assert.equal(res.body.receipt.paymentsSynced, 0);
});

test("payments同期有効時は受領→入金・分配→出金を同期（paymentsSynced=2）", async () => {
  const res = await request(app({ writeEnabled: true, role: "legal", syncPayments: true }))
    .post("/api/v2/condition-receipts").send({ ...validBody, receivedAmount: 9000 });
  assert.equal(res.status, 201);
  assert.equal(res.body.receipt.paymentsSynced, 2);
});

test("未知の条件行は404", async () => {
  const res = await request(app({ writeEnabled: true, role: "legal" }))
    .post("/api/v2/condition-receipts").send({ ...validBody, conditionLineId: 99 });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "RECEIPT_REFERENCE_NOT_FOUND");
});

test("不正なbody（period形式）は400", async () => {
  const res = await request(app({ writeEnabled: true, role: "legal" }))
    .post("/api/v2/condition-receipts").send({ ...validBody, period: "2026/08" });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "invalid request");
});
