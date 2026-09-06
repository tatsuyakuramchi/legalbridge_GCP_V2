import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createMatterDeliveryPaymentRouter } from "./delivery-payment-routes.js";
import { MemoryMatterDeliveryPaymentRepository } from "./delivery-payment-repository.js";

function appFor(options: { deliveries?: boolean; payments?: boolean; role?: "admin" | "legal" | "requester" } = {}) {
  const repository = new MemoryMatterDeliveryPaymentRepository({ 1: ["LEGAL-100", "LEGAL-101"], 2: [] });
  const app = express();
  app.use(express.json());
  app.use((_request, response, next) => {
    response.locals.currentUser = { email: "legal@arclight.co.jp", subject: "t", role: options.role ?? "legal", source: "disabled" };
    next();
  });
  app.use("/api/v2", createMatterDeliveryPaymentRouter(repository, {
    deliveryWriteEnabled: options.deliveries ?? true, paymentWriteEnabled: options.payments ?? true
  }));
  return { app, repository };
}

test("納品実績: 案件の代表課題キーで登録し、検収済みへ更新できる", async () => {
  const { app, repository } = appFor();
  const created = await request(app).post("/api/v2/matters/1/deliveries")
    .send({ deliveredOn: "2026-09-01", deliveredAmount: "150000", inspectionDeadline: "2026-09-15", note: "初回納品" });
  assert.equal(created.status, 201);
  assert.equal(created.body.delivery.backlogIssueKey, "LEGAL-100");
  assert.equal(created.body.delivery.status, "delivered");
  assert.equal(created.body.delivery.deliveredAmount, 150000);
  const updated = await request(app).patch(`/api/v2/matters/1/deliveries/${created.body.delivery.id}`)
    .send({ status: "inspected" });
  assert.equal(updated.status, 200);
  assert.equal(repository.deliveries[0].status, "inspected");
});

test("納品実績: 案件に紐づかない課題キー・課題キー無しの案件は 422", async () => {
  const { app } = appFor();
  const wrong = await request(app).post("/api/v2/matters/1/deliveries").send({ backlogIssueKey: "LEGAL-999" });
  assert.equal(wrong.status, 422);
  assert.equal(wrong.body.code, "MATTER_REFERENCE_INVALID");
  const noKey = await request(app).post("/api/v2/matters/2/deliveries").send({});
  assert.equal(noKey.status, 422);
  assert.equal(noKey.body.code, "MATTER_ISSUE_REQUIRED");
  const missing = await request(app).post("/api/v2/matters/9/deliveries").send({});
  assert.equal(missing.status, 404);
});

test("納品実績: 日付形式が不正なら 400・依頼者ロールは 403・未有効化は 503", async () => {
  const bad = await request(appFor().app).post("/api/v2/matters/1/deliveries").send({ deliveredOn: "2026/09/01" });
  assert.equal(bad.status, 400);
  const forbidden = await request(appFor({ role: "requester" }).app).post("/api/v2/matters/1/deliveries").send({});
  assert.equal(forbidden.status, 403);
  const disabled = await request(appFor({ deliveries: false }).app).post("/api/v2/matters/1/deliveries").send({});
  assert.equal(disabled.status, 503);
  assert.equal(disabled.body.code, "DELIVERY_WRITE_UNAVAILABLE");
});

test("支払: 登録（税込省略＝税抜と同額・支払日があれば paid）と支払済み更新", async () => {
  const { app, repository } = appFor();
  const planned = await request(app).post("/api/v2/matters/1/payments")
    .send({ amountExTax: 100000, totalAmount: 110000, dueDate: "2026-10-31", sourceDocumentNumber: "ARC-INS-2026-0001" });
  assert.equal(planned.status, 201);
  assert.equal(planned.body.payment.status, "planned");
  assert.equal(planned.body.payment.totalAmount, 110000);
  const paid = await request(app).post("/api/v2/matters/1/payments")
    .send({ amountExTax: 5000, paidDate: "2026-09-30", backlogIssueKey: "LEGAL-101" });
  assert.equal(paid.body.payment.status, "paid");
  assert.equal(paid.body.payment.totalAmount, 5000);
  assert.equal(paid.body.payment.backlogIssueKey, "LEGAL-101");
  const updated = await request(app).patch(`/api/v2/matters/1/payments/${planned.body.payment.id}`)
    .send({ status: "paid", paidDate: "2026-10-30" });
  assert.equal(updated.status, 200);
  assert.equal(repository.payments[0].status, "paid");
  assert.equal(repository.payments[0].paidDate, "2026-10-30");
});

test("支払: 支払台帳の capability が無効なら 503（納品は有効のまま）", async () => {
  const { app } = appFor({ payments: false });
  const payment = await request(app).post("/api/v2/matters/1/payments").send({ amountExTax: 1 });
  assert.equal(payment.status, 503);
  assert.equal(payment.body.code, "PAYMENT_WRITE_UNAVAILABLE");
  const delivery = await request(app).post("/api/v2/matters/1/deliveries").send({});
  assert.equal(delivery.status, 201);
});
