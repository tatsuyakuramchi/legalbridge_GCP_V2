import assert from "node:assert/strict";
import test from "node:test";
import { outboundConditionSchema } from "./outbound-conditions.js";
import { mapOutboundConditionForStorage } from "./outbound-condition-storage.js";

function licenseCondition() {
  return outboundConditionSchema.parse({
    workId: "work:42",
    workLabel: "W-2026-0042 作品",
    counterpartyId: "18",
    counterpartyLabel: "V-0018 Licensee",
    transactionKind: "license",
    conditionName: "英語版ライセンス",
    sourceConditionId: 7,
    documentNumber: "ARC-LC-2026-001",
    regions: [{ code: "US", name: "アメリカ合衆国" }, { code: "CA", name: "カナダ" }],
    languages: [{ code: "en", name: "英語" }, { code: "fr", name: "フランス語" }],
    exclusivity: "exclusive",
    sublicenseAllowed: true,
    termStart: "2026-09-01",
    termEnd: "2029-08-31",
    currency: "usd",
    paymentScheme: "royalty",
    ratePct: 5,
    mgAmount: 10000,
    advanceAmount: 2000,
    reportingCycle: "四半期",
    paymentTerms: "報告後30日以内",
    royaltyBase: "純売上額",
    sellOffPeriod: "終了後6か月",
    withholdingTaxTreatment: "租税条約適用後の税額を控除",
    notes: ""
  });
}

test("検証済みアウト条件をcondition_lines用の値へ変換する", () => {
  const value = mapOutboundConditionForStorage(licenseCondition());
  assert.equal(value.direction, "receivable");
  assert.equal(value.workId, 42);
  assert.equal(value.counterpartyVendorId, 18);
  assert.equal(value.transactionKind, "license");
  assert.equal(value.territory, "アメリカ合衆国、カナダ");
  assert.equal(value.language, "英語、フランス語");
  assert.deepEqual(value.regions.map((item) => item.code), ["US","CA"]);
  assert.deepEqual(value.languages.map((item) => item.code), ["en","fr"]);
  assert.equal(value.sourceConditionId, 7);
  assert.equal(value.agAmount, 2000);
  assert.equal(value.sellOffMonths, 6);
  assert.equal(value.notes, null);
});

test("原作IPをアウト側の自社作品として保存しない", () => {
  const value = { ...licenseCondition(), workId: "source_ip:42" };
  assert.throws(() => mapOutboundConditionForStorage(value), /Expected work identifier/);
});

test("曖昧なSell-Off期間を構造化せず拒否する", () => {
  const value = { ...licenseCondition(), sellOffPeriod: "契約終了後、在庫がなくなるまで" };
  assert.throws(() => mapOutboundConditionForStorage(value), /expressed in months/);
});
