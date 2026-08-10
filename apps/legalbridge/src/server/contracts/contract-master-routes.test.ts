import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createContractMasterRouter } from "./contract-master-routes.js";
import { MemoryContractMasterRepository, type ContractSummary } from "./contract-master-repository.js";

function seedRows(): ContractSummary[] {
  return [
    {
      id: 1, documentNumber: "K-2024-001", contractTitle: "業務委託契約", contractCategory: "outsourcing",
      contractType: "業務委託", lifecycleStage: "executed", contractStatus: "executed", primaryVendorId: 5,
      effectiveDate: "2024-04-01", expirationDate: "2025-03-31", autoRenewal: true,
      renewalNoticeMonths: 3, alertLeadMonths: 2, reviewDueDate: null
    },
    {
      id: 2, documentNumber: "K-2024-002", contractTitle: "秘密保持契約", contractCategory: "nda",
      contractType: "NDA", lifecycleStage: "reviewing", contractStatus: "reviewing", primaryVendorId: null,
      effectiveDate: null, expirationDate: null, autoRenewal: false,
      renewalNoticeMonths: null, alertLeadMonths: null, reviewDueDate: null
    }
  ];
}

function appFor(opts: { enabled?: boolean; role?: string; forbidden?: boolean; seed?: ContractSummary[] } = {}) {
  const repository = new MemoryContractMasterRepository(opts.seed ?? seedRows(), opts.forbidden ?? false);
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.currentUser = { email: "u@arclight.co.jp", subject: "t", role: opts.role ?? "admin", source: "test" } as never;
    next();
  });
  app.use("/api/v2", createContractMasterRouter(repository, opts.enabled ?? false));
  return { app, repository };
}

test("契約マスタ: viewer は403（読取）", async () => {
  const res = await request(appFor({ role: "viewer" }).app).get("/api/v2/contracts");
  assert.equal(res.status, 403);
});

test("契約マスタ: legal は一覧を取得できる", async () => {
  const res = await request(appFor({ role: "legal" }).app).get("/api/v2/contracts").expect(200);
  assert.equal(res.body.contracts.length, 2);
  assert.equal(res.body.writeEnabled, false);
});

test("契約マスタ: キーワード検索", async () => {
  const res = await request(appFor({}).app).get("/api/v2/contracts?q=NDA").expect(200);
  assert.equal(res.body.contracts.length, 1);
  assert.equal(res.body.contracts[0].documentNumber, "K-2024-002");
});

test("契約マスタ: 書込無効時は503（更新）", async () => {
  const res = await request(appFor({ enabled: false }).app)
    .patch("/api/v2/contracts/1").send({ contractTitle: "改訂版" });
  assert.equal(res.status, 503);
});

test("契約マスタ: 中核フィールドを更新", async () => {
  const target = appFor({ enabled: true });
  const res = await request(target.app).patch("/api/v2/contracts/1")
    .send({ contractTitle: "業務委託契約（改訂）", autoRenewal: false, alertLeadMonths: 1 }).expect(200);
  assert.equal(res.body.contract.contractTitle, "業務委託契約（改訂）");
  assert.equal(res.body.contract.autoRenewal, false);
  assert.equal(res.body.contract.alertLeadMonths, 1);
});

test("契約マスタ: 空更新は400", async () => {
  const res = await request(appFor({ enabled: true }).app).patch("/api/v2/contracts/1").send({});
  assert.equal(res.status, 400);
});

test("契約マスタ: 存在しない契約は404", async () => {
  const res = await request(appFor({ enabled: true }).app)
    .patch("/api/v2/contracts/999").send({ contractTitle: "X" });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "CONTRACT_NOT_FOUND");
});

test("契約マスタ: ライフサイクル状態変更（legacy contract_status は据え置き）", async () => {
  const target = appFor({ enabled: true });
  const res = await request(target.app).patch("/api/v2/contracts/2/status")
    .send({ lifecycleStage: "awaiting_signature" }).expect(200);
  assert.equal(res.body.contract.lifecycleStage, "awaiting_signature");
  // contract_status は V1 の文書レベル語彙を持つ legacy 列。V2 語彙で汚染しない（監査 P0-7）。
  assert.equal(res.body.contract.contractStatus, "reviewing");
});

test("契約マスタ: 不正な状態は400", async () => {
  const res = await request(appFor({ enabled: true }).app)
    .patch("/api/v2/contracts/1/status").send({ lifecycleStage: "bogus" });
  assert.equal(res.status, 400);
});

test("契約マスタ: 編集不可ロールは403（更新）", async () => {
  const res = await request(appFor({ enabled: true, role: "viewer" }).app)
    .patch("/api/v2/contracts/1").send({ contractTitle: "X" });
  assert.equal(res.status, 403);
});

test("契約マスタ: 権限未整備(FORBIDDEN_DB)は503", async () => {
  const res = await request(appFor({ enabled: true, forbidden: true }).app)
    .patch("/api/v2/contracts/1").send({ contractTitle: "X" });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "CONTRACT_MASTER_FORBIDDEN_DB");
});
