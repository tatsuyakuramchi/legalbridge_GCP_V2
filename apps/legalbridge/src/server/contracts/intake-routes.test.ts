import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import {
  MemoryContractIntakeRepository
} from "./intake-repository.js";
import { createContractIntakeRouter } from "./intake.js";

const input = {
  sourceWork: {
    title: "原作テスト",
    workType: "board_game"
  },
  ownWork: {
    title: "自社作品テスト",
    workType: "board_game",
    status: "planning"
  },
  materials: [{
    materialName: "ゲームデザイン",
    materialType: "game_design",
    materialRole: "core_logic",
    acquisitionType: "license",
    rightsType: "license",
    isDefault: true
  }],
  contract: {
    documentNumber: "TEST-LIC-2026-0001",
    contractTitle: "テスト利用許諾契約",
    primaryVendorId: 18,
    executedAt: "2026-08-01"
  },
  inboundConditions: [{
    conditionName: "原作利用許諾",
    transactionKind: "license",
    materialIndex: 0,
    territory: "日本",
    languages: ["日本語"],
    paymentScheme: "royalty",
    ratePct: 5
  }],
  outboundConditions: []
};

function appFor(
  repository: MemoryContractIntakeRepository,
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
  app.use("/api/v2", createContractIntakeRouter(repository, writeEnabled));
  return app;
}

test("DBプリフライトは書込ゲート無効時でも参照だけを許可する", async () => {
  const repository = new MemoryContractIntakeRepository();
  const response = await request(appFor(repository, false))
    .post("/api/v2/contract-intakes/preflight")
    .send(input);
  assert.equal(response.status, 200);
  assert.equal(response.body.preview.committable, true);
  assert.equal(repository.saved.length, 0);
});

test("専用ゲート無効時は契約取込を保存しない", async () => {
  const repository = new MemoryContractIntakeRepository();
  const response = await request(appFor(repository, false))
    .post("/api/v2/contract-intakes")
    .send({
      confirmation: "COMMIT_PRODUCTION_CONTRACT_INTAKE",
      intake: input
    });
  assert.equal(response.status, 503);
  assert.equal(repository.saved.length, 0);
});

test("管理者以外は契約取込を保存できない", async () => {
  const repository = new MemoryContractIntakeRepository();
  const response = await request(appFor(repository, true, "legal"))
    .post("/api/v2/contract-intakes")
    .send({
      confirmation: "COMMIT_PRODUCTION_CONTRACT_INTAKE",
      intake: input
    });
  assert.equal(response.status, 403);
  assert.equal(repository.saved.length, 0);
});

test("本番確認文字列がなければ契約取込を保存しない", async () => {
  const repository = new MemoryContractIntakeRepository();
  const response = await request(appFor(repository, true))
    .post("/api/v2/contract-intakes")
    .send({ confirmation: "WRONG", intake: input });
  assert.equal(response.status, 400);
  assert.equal(repository.saved.length, 0);
});

test("全ゲート通過時だけ契約取込を保存し外部連携を起動しない", async () => {
  const repository = new MemoryContractIntakeRepository();
  const response = await request(appFor(repository, true))
    .post("/api/v2/contract-intakes")
    .send({
      confirmation: "COMMIT_PRODUCTION_CONTRACT_INTAKE",
      intake: input
    });
  assert.equal(response.status, 201);
  assert.equal(repository.saved.length, 1);
  assert.equal(response.body.intake.documentNumber, "TEST-LIC-2026-0001");
  assert.equal(response.body.integrations.slack, "disabled");
  assert.equal(response.body.integrations.backlog, "disabled");
  assert.equal(response.body.integrations.drive, "disabled");
});
