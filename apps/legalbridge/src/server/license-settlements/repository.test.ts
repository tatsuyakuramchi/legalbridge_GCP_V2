import assert from "node:assert/strict";
import test from "node:test";
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
    bankName: "テスト銀行",
    branchName: "本店",
    accountType: "普通",
    accountNo: "1234567",
    accountHolder: "クリエイター エー",
    invoiceRegistrationNumber: null,
    documentNumber: "LIC-IN-1",
    contractId: 100,
    contractTitle: "利用許諾基本契約",
    ...overrides
  };
}

test("サブライセンス料入金はOUT条件から親IN条件を辿って精算する", async () => {
  const inbound = condition({ id: 10, direction: "payable", flowDirection: "in", ratePct: 25 });
  const outbound = condition({
    id: 20,
    name: "Germany sublicense",
    direction: "receivable",
    flowDirection: "out",
    ratePct: 8,
    parentLicenseConditionId: 10,
    counterparty: "Spiel GmbH"
  });
  const repo = new MemoryLicenseSettlementRepository([inbound, outbound]);
  const result = await repo.preview({
    conditionLineId: 20,
    trigger: "sublicense_receipt",
    occurredAt: "2026-09-04T00:00:00+09:00",
    grossAmount: 8000,
    deductions: 850,
    useNetBasis: true
  });

  assert.equal(result.sourceCondition.id, 20);
  assert.equal(result.settlementCondition.id, 10);
  assert.equal(result.basisAmount, 7150);
  assert.equal(result.ratePct, 25);
  assert.equal(result.actualRoyalty, 1787.5);
});

test("製造イベントはサンプル数を除いた数量×基準単価×料率で計算する", async () => {
  const inbound = condition({ id: 11, ratePct: 5, currency: "JPY" });
  const repo = new MemoryLicenseSettlementRepository([inbound]);
  const result = await repo.preview({
    conditionLineId: 11,
    trigger: "manufacturing",
    occurredAt: "2026-09-01T00:00:00+09:00",
    quantity: 10000,
    sampleQuantity: 100,
    unitBase: 2000
  });

  assert.equal(result.billableQuantity, 9900);
  assert.equal(result.grossEventAmount, 19800000);
  assert.equal(result.actualRoyalty, 990000);
});

test("MG/AGをイベントごとに自動上乗せしない", async () => {
  const inbound = condition({ id: 12, ratePct: 10, mgAmount: 10000, agAmount: 5000 });
  const repo = new MemoryLicenseSettlementRepository([inbound]);
  const result = await repo.preview({
    conditionLineId: 12,
    trigger: "sale",
    occurredAt: "2026-09-02T00:00:00+09:00",
    grossAmount: 1000
  });

  assert.equal(result.actualRoyalty, 100);
});
