import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createContractOutboundRouter } from "./intake-outbound-routes.js";
import { MemoryContractOutboundRepository } from "./intake-outbound-repository.js";

const condition = {
  conditionName: "国内商品化",
  transactionKind: "license",
  materialIndex: 0,
  territory: "日本",
  languages: ["日本語"],
  exclusivity: "non_exclusive",
  paymentScheme: "royalty",
  ratePct: 8,
  royaltyBase: "希望小売価格",
  counterpartyVendorId: 30
};

function appFor(
  outbound: MemoryContractOutboundRepository | undefined,
  writeEnabled: boolean,
  role: "admin" | "legal" = "admin"
) {
  const app = express();
  app.use(express.json());
  app.use((_request, response, next) => {
    response.locals.currentUser = {
      email: "tester@arclight.co.jp",
      subject: "test",
      role,
      source: "disabled"
    };
    next();
  });
  app.use("/api/v2", createContractOutboundRouter(outbound, writeEnabled));
  return app;
}

test("アウト条件の入力検証は書込ゲート無効でも参照だけ許可する", async () => {
  const outbound = new MemoryContractOutboundRepository();
  const response = await request(appFor(outbound, false))
    .post("/api/v2/contract-intakes/outbound-conditions/validate")
    .send({ conditions: [condition] });
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
});

test("ロイヤリティ方式で料率がないアウト条件を拒否する", async () => {
  const outbound = new MemoryContractOutboundRepository();
  const response = await request(appFor(outbound, false))
    .post("/api/v2/contract-intakes/outbound-conditions/validate")
    .send({ conditions: [{ ...condition, ratePct: undefined }] });
  assert.equal(response.status, 400);
  assert.equal(response.body.ok, false);
});

test("書込ゲート無効時はアウト条件を保存しない", async () => {
  const outbound = new MemoryContractOutboundRepository();
  const response = await request(appFor(outbound, false))
    .post("/api/v2/contract-intakes/500/outbound-conditions")
    .send({ conditions: [condition] });
  assert.equal(response.status, 503);
});

test("管理者以外はアウト条件を保存できない", async () => {
  const outbound = new MemoryContractOutboundRepository();
  const response = await request(appFor(outbound, true, "legal"))
    .post("/api/v2/contract-intakes/500/outbound-conditions")
    .send({ conditions: [condition] });
  assert.equal(response.status, 403);
});

test("全ゲート通過時はアウト条件をcondition_lineとして追記し外部連携を起動しない", async () => {
  const outbound = new MemoryContractOutboundRepository();
  const response = await request(appFor(outbound, true))
    .post("/api/v2/contract-intakes/500/outbound-conditions")
    .send({ conditions: [condition] });
  assert.equal(response.status, 201);
  assert.equal(response.body.appended.length, 1);
  assert.equal(response.body.appended[0].counterpartyVendorId, 30);
  assert.equal(response.body.integrations.slack, "disabled");

  const list = await request(appFor(outbound, true))
    .get("/api/v2/contract-intakes/500/outbound-conditions");
  assert.equal(list.status, 200);
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].conditionName, "国内商品化");
});

test("登録済み契約が存在しない文書へのアウト追記を拒否する", async () => {
  const outbound = new MemoryContractOutboundRepository(new Set([500]));
  const response = await request(appFor(outbound, true))
    .post("/api/v2/contract-intakes/999/outbound-conditions")
    .send({ conditions: [condition] });
  assert.equal(response.status, 404);
  assert.equal(response.body.code, "CONTRACT_INTAKE_DOCUMENT_NOT_FOUND");
});
