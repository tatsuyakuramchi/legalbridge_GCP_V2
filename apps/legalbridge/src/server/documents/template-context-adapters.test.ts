import assert from "node:assert/strict";
import test from "node:test";
import { buildTemplateDocumentContext, isTemplateGeneratedVariable } from "./template-context-adapters.js";

test("royalty statement single mode uses source currency unit", () => {
  const eur = buildTemplateDocumentContext("royalty_statement", {
    statementMode: "single",
    currency: "EUR",
    lines: [{ sales_amount: 1000, royalty_amount: 250 }]
  });
  assert.equal(eur.moneyUnit, "€");
  assert.equal(eur.statementMode, "single");

  const jpy = buildTemplateDocumentContext("royalty_statement", {
    statementMode: "single",
    currency: "JPY",
    lines: [{ sales_amount: 1000, royalty_amount: 250 }]
  });
  assert.equal(jpy.moneyUnit, "¥");
});

test("royalty statement multi mode remains JPY display and accepts legacy rs_receipts", () => {
  const receipt = {
    sublicensee: "Spiel GmbH",
    receivedOn: "2026-09-04",
    amountStr: "EUR 8,000",
    conversionStr: "入金日レート",
    jpyBaseStr: "1,320,000"
  };
  const context = buildTemplateDocumentContext("royalty_statement", {
    statementMode: "multi",
    currency: "EUR",
    rs_receipts: [receipt],
    lineGroups: [{
      contractTitle: "Creator A",
      lines: [{ salesJpy: 1320000, paymentJpy: 330000 }]
    }]
  });
  assert.equal(context.moneyUnit, "¥");
  assert.deepEqual(context.receiptRows, [receipt]);
});

test("royalty statement compatibility knows receiptRows and moneyUnit are generated", () => {
  assert.equal(isTemplateGeneratedVariable("royalty_statement", "receiptRows"), true);
  assert.equal(isTemplateGeneratedVariable("royalty_statement", "moneyUnit"), true);
});

// テンプレ 079（業務委託条件・検収の選択値ブロック）の表示フラグ。値が無ければ描かない＝旧文書の出力は不変。
test("service flow blocks: hasServiceTerms / hasInspectionChoices are set only when a selection exists", () => {
  const master = buildTemplateDocumentContext("service_master", { SERVICE_ENGAGEMENT_TYPE: "請負" });
  assert.equal(master.hasServiceTerms, true);
  assert.equal(buildTemplateDocumentContext("service_master", { PROJECT_TITLE: "x" }).hasServiceTerms, false);
  const po = buildTemplateDocumentContext("purchase_order", { WITHHOLDING_TAX: "対象", items: [] });
  assert.equal(po.hasServiceTerms, true);
  assert.equal(buildTemplateDocumentContext("purchase_order", { items: [] }).hasServiceTerms, false);
  const inspection = buildTemplateDocumentContext("inspection_certificate", { INSPECTION_RESULT: "合格", delivery_line_items: [] });
  assert.equal(inspection.hasInspectionChoices, true);
  assert.equal(buildTemplateDocumentContext("inspection_certificate", { delivery_line_items: [] }).hasInspectionChoices, false);
  for (const [key, variable] of [["purchase_order", "hasServiceTerms"], ["intl_purchase_order", "WITHHOLDING_TAX"], ["inspection_certificate", "hasInspectionChoices"]]) {
    assert.equal(isTemplateGeneratedVariable(key, variable), true, `${key}.${variable}`);
  }
});
