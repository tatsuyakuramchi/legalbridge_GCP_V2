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
    territory: "全世界",
    language: "全言語",
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

test("再許諾は取引モデルをIN、地域と言語をOUTから引用して製品名を作る", async () => {
  const inbound = condition({ id: 10, name: "再許諾", direction: "payable", flowDirection: "in", ratePct: 25 });
  const outbound = condition({
    id: 20,
    name: "Germany sublicense",
    direction: "receivable",
    flowDirection: "out",
    ratePct: 8,
    parentLicenseConditionId: 10,
    counterparty: "Spiel GmbH",
    territory: "デンマーク・ノルウェー",
    language: "デンマーク語・ノルウェー語"
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
  assert.equal(result.productName, "再許諾 ／ 許諾地域：デンマーク・ノルウェー ／ 許諾言語：デンマーク語・ノルウェー語");
  assert.equal(result.licenseScopeSource, "out");
});

test("自社製造・自社販売はIN条件の地域と言語を使う", async () => {
  const inbound = condition({ id: 11, name: "自社製造・自社販売", ratePct: 5, currency: "JPY", territory: "日本", language: "日本語" });
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
  assert.equal(result.productName, "自社製造・自社販売 ／ 許諾地域：日本 ／ 許諾言語：日本語");
  assert.equal(result.licenseScopeSource, "in");
});

test("自社製造・他社販売はOUT条件（販売先）の地域と言語を使う（イン側は自社製造・自社販売だけ）", async () => {
  const inbound = condition({ id: 13, name: "自社製造・他社販売", territory: "全世界", language: "全言語" });
  const outbound = condition({ id: 14, name: "販売委託先", direction: "receivable", flowDirection: "out",
    parentLicenseConditionId: 13, territory: "ドイツ", language: "ドイツ語" });
  const result = await new MemoryLicenseSettlementRepository([inbound, outbound]).preview({
    conditionLineId: 14, trigger: "sale", occurredAt: "2026-09-02T00:00:00+09:00", grossAmount: 1000
  });
  assert.equal(result.productName, "自社製造・他社販売 ／ 許諾地域：ドイツ ／ 許諾言語：ドイツ語");
  assert.equal(result.licenseScopeSource, "out");
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
