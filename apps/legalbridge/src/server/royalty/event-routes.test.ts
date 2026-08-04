import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createRoyaltyEventRouter } from "./event-routes.js";
import { MemoryRoyaltyEventRepository } from "./event-repository.js";

function app(opts: { writeEnabled?: boolean; role?: string } = {}) {
  const a = express();
  a.use(express.json());
  a.use((_req, res, next) => {
    res.locals.currentUser = opts.role
      ? ({ email: "u@example.com", role: opts.role, subject: "u", source: "test" } as never)
      : undefined;
    next();
  });
  a.use("/api/v2", createRoyaltyEventRouter(
    opts.writeEnabled ? new MemoryRoyaltyEventRepository(new Set([1]), new Set([10])) : undefined,
    opts.writeEnabled ?? false
  ));
  return a;
}

const validBody = {
  confirmation: "COMMIT_PRODUCTION_ROYALTY_EVENT",
  conditionLineId: 1,
  documentId: 10,
  period: "2026-08",
  terms: { type: "performance", base_price: 1000, rate_pct: 10, quantity: 100 },
  adjustments: { acceptance_ratio: 0.8, mg_amount: 9000, ag_amount: 4000 }
};

test("既定OFF（writeEnabled=false）は503", async () => {
  const res = await request(app({ role: "legal" })).post("/api/v2/royalty/events").send(validBody);
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "ROYALTY_EVENT_STORAGE_UNAVAILABLE");
});

test("admin/legal 以外のロールは403", async () => {
  const res = await request(app({ writeEnabled: true, role: "requester" })).post("/api/v2/royalty/events").send(validBody);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "ROYALTY_EVENT_ROLE_REQUIRED");
});

test("確認トークン不一致は400", async () => {
  const res = await request(app({ writeEnabled: true, role: "legal" }))
    .post("/api/v2/royalty/events").send({ ...validBody, confirmation: "WRONG" });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "ROYALTY_EVENT_CONFIRMATION_REQUIRED");
});

test("正常系：サーバ再計算した実支払でイベントを記録する", async () => {
  const res = await request(app({ writeEnabled: true, role: "legal" })).post("/api/v2/royalty/events").send(validBody);
  assert.equal(res.status, 201);
  // gross 10000 → 歩留0.8 → 8000 → MG floor 9000 → AG 4000相殺 → 実支払 5000
  assert.equal(res.body.fee.actual_ex_tax, 5000);
  assert.equal(res.body.event.amountExTax, 5000);   // フロント値ではなく再計算値
  assert.equal(res.body.event.eventNo, 1);
  assert.equal(res.body.event.period, "2026-08");
});

test("未知の条件行は404", async () => {
  const res = await request(app({ writeEnabled: true, role: "admin" }))
    .post("/api/v2/royalty/events").send({ ...validBody, conditionLineId: 99 });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "ROYALTY_EVENT_REFERENCE_NOT_FOUND");
});

test("不正なbody（period形式違反）は400", async () => {
  const res = await request(app({ writeEnabled: true, role: "legal" }))
    .post("/api/v2/royalty/events").send({ ...validBody, period: "2026/08" });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "invalid request");
});
