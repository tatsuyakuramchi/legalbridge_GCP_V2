import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createRoyaltyRouter } from "./routes.js";

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/v2", createRoyaltyRouter());
  return a;
}

test("試算：業績連動＋歩留＋MG＋源泉のフルカスケードを返す", async () => {
  const response = await request(app())
    .post("/api/v2/royalty/preview")
    .send({
      terms: { type: "performance", base_price: 1000, rate_pct: 10, quantity: 100 },
      adjustments: { acceptance_ratio: 0.8, mg_amount: 9000, ag_amount: 4000 },
      taxRatePct: 10,
      withholding: { formOverride: true }
    });
  assert.equal(response.status, 200);
  assert.equal(response.body.fee.gross_ex_tax, 10000);
  assert.equal(response.body.fee.actual_ex_tax, 5000);      // MG floor 9000 − AG 4000
  assert.equal(response.body.withholdingEnabled, true);
  assert.equal(response.body.payment.consumptionTax, 500);  // ceil(5000×10%)
  assert.equal(response.body.payment.taxIncluded, 5500);
  assert.equal(response.body.payment.withholdingTax, 561);  // floor(5500×0.1021)
  assert.equal(response.body.payment.netTransfer, 4939);
});

test("試算：源泉非対象なら源泉0・振込=税込", async () => {
  const response = await request(app())
    .post("/api/v2/royalty/preview")
    .send({ terms: { type: "revenue", base_amount: 100000, rate_pct: 10 } });
  assert.equal(response.status, 200);
  assert.equal(response.body.fee.actual_ex_tax, 10000);
  assert.equal(response.body.withholdingEnabled, false);
  assert.equal(response.body.payment.withholdingTax, 0);
  assert.equal(response.body.payment.netTransfer, 11000);
});

test("試算：不正なbodyは400", async () => {
  const response = await request(app())
    .post("/api/v2/royalty/preview")
    .send({ terms: { type: "unknown" } });
  assert.equal(response.status, 400);
  assert.equal(response.body.error, "invalid request");
});
