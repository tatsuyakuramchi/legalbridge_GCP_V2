import assert from "node:assert/strict";
import test from "node:test";
import { refreshRoyaltyProductForEdit } from "./royalty-edit-refresh.js";

function response(body: unknown) {
  return { ok: true, json: async () => body } as Response;
}

test("既存計算書の編集開始時に明細を含む製品名をOUT条件から再補完する", async () => {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return response({ preview: {
      productName: "再許諾 ／ 許諾地域：北欧 ／ 許諾言語：英語",
      transactionModelName: "再許諾", licenseTerritory: "北欧", licenseLanguage: "英語", licenseScopeSource: "out"
    } });
  }) as typeof fetch;
  const result = await refreshRoyaltyProductForEdit({
    source_condition_line_id: 590, source_out_condition_line_id: 592,
    productName: "Gameplay Publishing ApS", lines: [{ productName: "Gameplay Publishing ApS" }]
  }, fetcher);
  assert.equal(result.changed, true);
  assert.equal(result.formData.productName, "再許諾 ／ 許諾地域：北欧 ／ 許諾言語：英語");
  assert.equal((result.formData.lines as Array<Record<string, unknown>>)[0].productName, result.formData.productName);
  assert.equal(calls[0], "/api/v2/license-settlements/preview");
});

test("旧下書きは入金元と親IN条件からOUT条件を一意に特定する", async () => {
  let previewCount = 0;
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("conditions?")) return response({ conditions: [{
      id: 592, direction: "receivable", parentLicenseConditionId: 590, counterparty: "Gameplay Publishing ApS"
    }] });
    const current = previewCount++;
    return response({ preview: current === 0 ? {
      productName: "再許諾 ／ 許諾地域：全世界 ／ 許諾言語：全言語",
      transactionModelName: "再許諾", licenseTerritory: "全世界", licenseLanguage: "全言語", licenseScopeSource: "in"
    } : {
      productName: "再許諾 ／ 許諾地域：北欧 ／ 許諾言語：英語",
      transactionModelName: "再許諾", licenseTerritory: "北欧", licenseLanguage: "英語", licenseScopeSource: "out"
    } });
  }) as typeof fetch;
  const result = await refreshRoyaltyProductForEdit({
    rsConditionLineId: 590, payerCompany: "Gameplay Publishing ApS", productName: "Gameplay Publishing ApS"
  }, fetcher);
  assert.equal(result.changed, true);
  assert.equal(result.formData.source_out_condition_line_id, 592);
  assert.equal(result.formData.licenseScopeSource, "out");
});
