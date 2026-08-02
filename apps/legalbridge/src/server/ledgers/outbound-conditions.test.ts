import assert from "node:assert/strict";
import test from "node:test";
import { validateOutboundCondition } from "./outbound-conditions.js";

const base = {
  workId: "work:10",
  workLabel: "W-2026-0001 テスト作品",
  counterpartyId: "20",
  counterpartyLabel: "海外ライセンシー",
  conditionName: "英語版ライセンス",
  territory: "全世界",
  languages: ["英語"],
  exclusivity: "non_exclusive",
  sublicenseAllowed: false,
  currency: "usd",
  reportingCycle: "四半期",
  paymentTerms: "報告後30日以内"
};

test("ライセンスアウト条件を受取方向として検証する", () => {
  const result = validateOutboundCondition({
    ...base,
    transactionKind: "license",
    paymentScheme: "royalty",
    ratePct: 5,
    mgAmount: 10000
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.condition.direction, "receivable");
    assert.equal(result.condition.currency, "USD");
    assert.equal(result.condition.ratePct, 5);
  }
});

test("プロダクトアウト条件を単価方式で検証する", () => {
  const result = validateOutboundCondition({
    ...base,
    conditionName: "海外卸売",
    transactionKind: "product",
    paymentScheme: "per_unit",
    amountExTax: 1200,
    minimumQuantity: 100,
    incoterms: "EXW"
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.condition.transactionKind, "product");
});

test("アウト条件の類型と金銭条件の不整合を拒否する", () => {
  const result = validateOutboundCondition({
    ...base,
    transactionKind: "license",
    paymentScheme: "per_unit",
    amountExTax: 1000
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.errors.some((error) => error.field === "paymentScheme"));
  }
});

test("契約期間と料率の不正値を拒否する", () => {
  const result = validateOutboundCondition({
    ...base,
    transactionKind: "license",
    paymentScheme: "royalty",
    ratePct: 101,
    termStart: "2027-01-01",
    termEnd: "2026-01-01"
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.errors.some((error) => error.field === "ratePct"));
    assert.ok(result.errors.some((error) => error.field === "termEnd"));
  }
});
