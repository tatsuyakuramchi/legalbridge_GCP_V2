import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { MemoryDraftRepository } from "../documents/draft-repository.js";
import { MemoryTemplateRepository } from "../documents/template-repository.js";
import { createContractIntakeDocumentRouter } from "./intake-document-routes.js";
import {
  MemoryContractIntakeDocumentSourceRepository,
  type ContractIntakeDocumentSource
} from "./intake-document-repository.js";
import { contractIntakeSchema } from "./intake.js";

function intakeFor(documentNumber: string, contractTitle: string) {
  return contractIntakeSchema.parse({
    sourceWork: { existingWorkId: 10 },
    ownWork: { existingWorkId: 11 },
    materials: [{ existingMaterialId: 100, isDefault: true, isRoyaltyBearing: true }],
    contract: {
      documentNumber,
      contractTitle,
      primaryVendorId: 20,
      executedAt: "2026-08-01"
    },
    inboundConditions: [{
      conditionName: "原作ロイヤリティ",
      transactionKind: "license",
      materialIndex: 0,
      territory: "日本",
      languages: ["日本語"],
      paymentScheme: "royalty",
      ratePct: 5
    }],
    outboundConditions: []
  });
}

function source(
  documentId: number,
  documentNumber: string,
  contractTitle: string
): ContractIntakeDocumentSource {
  const intake = intakeFor(documentNumber, contractTitle);
  return {
    documentId,
    contractId: documentId + 1000,
    documentNumber,
    intake,
    sourceWork: { id: 10, workCode: "LO-2026-0001", title: "原作作品" },
    ownWork: { id: 11, workCode: "W-2026-0001", title: "自社商品" },
    materials: [{
      id: 100,
      materialCode: "LO-2026-0001-001",
      materialName: "ゲームデザイン",
      rightsHolderLabel: ""
    }],
    vendors: {
      20: {
        id: 20,
        vendorName: "原作権利者",
        entityType: "法人",
        address: "東京都",
        representative: "代表者",
        contactName: "担当者",
        phone: "",
        email: ""
      }
    },
    outboundConditions: []
  };
}

function appFor(
  sources: MemoryContractIntakeDocumentSourceRepository | undefined,
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
  app.use("/api/v2", createContractIntakeDocumentRouter(
    sources,
    new MemoryTemplateRepository([]),
    new MemoryDraftRepository(),
    false
  ));
  return app;
}

test("登録済み契約取込を新しい順に一覧する", async () => {
  const sources = new MemoryContractIntakeDocumentSourceRepository(new Map([
    [501, source(501, "LIC-2026-0001", "原作利用許諾契約A")],
    [503, source(503, "LIC-2026-0003", "原作利用許諾契約B")]
  ]));
  const response = await request(appFor(sources)).get("/api/v2/contract-intakes");
  assert.equal(response.status, 200);
  assert.equal(response.body.items.length, 2);
  assert.equal(response.body.items[0].documentId, 503);
  assert.equal(response.body.items[0].documentNumber, "LIC-2026-0003");
  assert.equal(response.body.items[0].primaryVendorName, "原作権利者");
  assert.equal(response.body.items[0].inboundConditionCount, 1);
  assert.equal(response.body.items[1].documentId, 501);
});

test("limitで一覧件数を制限する", async () => {
  const sources = new MemoryContractIntakeDocumentSourceRepository(new Map([
    [501, source(501, "LIC-2026-0001", "契約A")],
    [502, source(502, "LIC-2026-0002", "契約B")],
    [503, source(503, "LIC-2026-0003", "契約C")]
  ]));
  const response = await request(appFor(sources))
    .get("/api/v2/contract-intakes?limit=2");
  assert.equal(response.status, 200);
  assert.equal(response.body.items.length, 2);
  assert.equal(response.body.items[0].documentId, 503);
  assert.equal(response.body.items[1].documentId, 502);
});

test("管理者以外は登録済み契約取込を一覧できない", async () => {
  const sources = new MemoryContractIntakeDocumentSourceRepository(new Map([
    [501, source(501, "LIC-2026-0001", "契約A")]
  ]));
  const response = await request(appFor(sources, "legal"))
    .get("/api/v2/contract-intakes");
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "CONTRACT_INTAKE_ADMIN_REQUIRED");
});

test("レジストリ未接続時は503を返す", async () => {
  const response = await request(appFor(undefined)).get("/api/v2/contract-intakes");
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "CONTRACT_INTAKE_REGISTRY_UNAVAILABLE");
});
