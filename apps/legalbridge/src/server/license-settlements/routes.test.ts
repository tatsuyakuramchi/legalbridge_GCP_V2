import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { MemoryDraftRepository } from "../documents/draft-repository.js";
import { MemoryTemplateRepository } from "../documents/template-repository.js";
import { createLicenseSettlementRouter } from "./routes.js";
import {
  MemoryLicenseSettlementRepository,
  type SettlementCondition
} from "./repository.js";

function condition(overrides: Partial<SettlementCondition>): SettlementCondition {
  return {
    id: 1,
    name: "利用許諾条件",
    workId: 10,
    workCode: "WRK-00010",
    workTitle: "テスト作品",
    direction: "payable",
    flowDirection: "in",
    paymentScheme: "royalty",
    calcType: null,
    ratePct: 25,
    amountExTax: null,
    unitAmount: null,
    mgAmount: null,
    agAmount: null,
    currency: "EUR",
    paymentTerms: "入金後30日",
    royaltyBase: "当社実受領額",
    deductibleCosts: "海外源泉税・送金手数料",
    parentLicenseConditionId: null,
    counterpartyVendorId: 5,
    counterparty: "Creator A",
    counterpartyEntityType: "個人",
    counterpartyRepresentative: null,
    bankName: "Test Bank",
    branchName: "Main",
    accountType: "普通",
    accountNo: "1234567",
    accountHolder: "CREATOR A",
    invoiceRegistrationNumber: null,
    documentNumber: "LIC-IN-1",
    contractId: 100,
    contractTitle: "利用許諾基本契約",
    ...overrides
  };
}

test("sublicense receipt draft stores basis amount, currency-neutral display numbers and vendor bank data", async () => {
  const inbound = condition({ id: 10 });
  const outbound = condition({
    id: 20,
    direction: "receivable",
    flowDirection: "out",
    parentLicenseConditionId: 10,
    counterparty: "Spiel GmbH",
    ratePct: 8
  });
  const drafts = new MemoryDraftRepository();
  const templates = new MemoryTemplateRepository([{
    templateKey: "royalty_statement",
    templateVersionId: 8,
    label: "利用許諾料計算書",
    category: "License",
    fields: []
  }]);
  const app = express();
  app.use(express.json());
  app.use("/api/v2", createLicenseSettlementRouter(
    new MemoryLicenseSettlementRepository([inbound, outbound]),
    templates,
    drafts,
    true
  ));

  const response = await request(app)
    .post("/api/v2/license-settlements/draft")
    .send({
      issueKey: "LEGAL-100",
      conditionLineId: 20,
      trigger: "sublicense_receipt",
      occurredAt: "2026-09-04T00:00:00+09:00",
      grossAmount: 8000,
      deductions: 850,
      useNetBasis: true,
      taxRate: 10
    });

  assert.equal(response.status, 201);
  const form = response.body.draft.formData;
  assert.equal(form.settlement_basis_amount, 7150);
  assert.equal(form.msrpStr, "7,150");
  assert.equal(form.royaltyRatePct, 25);
  assert.equal(form.grossRoyaltyStr, "1,787.5");
  assert.equal(form.actualRoyaltyStr, "1,787.5");
  assert.equal(form.taxRate, 10);
  assert.equal(form.taxAmount, "179");
  assert.equal(form.totalPaymentStr, "1,966.5");
  assert.equal(form.currency, "EUR");
  assert.equal(form.bankName, "Test Bank");
  assert.equal(form.accountNo, "1234567");
  assert.equal(form.LICENSOR_SUFFIX, "様");
  assert.equal(form.source_out_condition_line_id, 20);
  assert.equal(form.source_condition_line_id, 10);
});
