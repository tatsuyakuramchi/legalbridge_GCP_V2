import assert from "node:assert/strict";
import test from "node:test";
import { looseNameMatch, refreshRoyaltyProductForEdit } from "./royalty-edit-refresh.js";

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
    productName: "Gameplay Publishing ApS",
    lines: [{ productName: "Gameplay Publishing ApS" }],
    rs_receipts: [{ sublicensee: "Gameplay Publishing ApS", amount: 14324 }],
    lineGroups: [{ lines: [{ productName: "Gameplay Publishing ApS" }] }]
  }, fetcher);
  assert.equal(result.changed, true);
  assert.equal(result.formData.productName, "再許諾 ／ 許諾地域：北欧 ／ 許諾言語：英語");
  assert.equal((result.formData.lines as Array<Record<string, unknown>>)[0].productName, result.formData.productName);
  assert.equal((result.formData.rs_receipts as Array<Record<string, unknown>>)[0].productName, result.formData.productName);
  assert.equal(
    ((result.formData.lineGroups as Array<Record<string, unknown>>)[0].lines as Array<Record<string, unknown>>)[0].productName,
    result.formData.productName
  );
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

test("複数サブライセンシーの受領明細は行ごとに対応するOUT条件で製品名を再補完する", async () => {
  const conditionSearches: string[] = [];
  const previewIds: number[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("conditions?")) {
      conditionSearches.push(url);
      const payer = decodeURIComponent(url.match(/q=([^&]+)/)?.[1] ?? "");
      return response({ conditions: [{
        id: payer === "Broadway Toys Limited" ? 601 : 602,
        direction: "receivable", parentLicenseConditionId: 590, counterparty: payer
      }] });
    }
    const conditionLineId = Number(JSON.parse(String(init?.body)).conditionLineId);
    previewIds.push(conditionLineId);
    const scope = conditionLineId === 601
      ? ["英国", "英語"]
      : conditionLineId === 602 ? ["スペイン", "スペイン語"] : ["全世界", "全言語"];
    return response({ preview: {
      productName: `再許諾 ／ 許諾地域：${scope[0]} ／ 許諾言語：${scope[1]}`,
      transactionModelName: "再許諾", licenseTerritory: scope[0], licenseLanguage: scope[1],
      licenseScopeSource: conditionLineId === 590 ? "in" : "out"
    } });
  }) as typeof fetch;
  const result = await refreshRoyaltyProductForEdit({
    source_condition_line_id: 590,
    source_out_condition_line_id: 999, // 旧文書全体キーは複数相手先へ流用しない
    rs_receipts: [
      { sublicensee: "Broadway Toys Limited", amount: 221804 },
      { sublicensee: "Maldito Games", amount: 302442 },
      { sublicensee: "Maldito Games", amount: 1384866 }
    ]
  }, fetcher);
  const receipts = result.formData.rs_receipts as Array<Record<string, unknown>>;
  assert.equal(receipts[0].productName, "再許諾 ／ 許諾地域：英国 ／ 許諾言語：英語");
  assert.equal(receipts[0].source_out_condition_line_id, 601);
  assert.equal(receipts[1].productName, "再許諾 ／ 許諾地域：スペイン ／ 許諾言語：スペイン語");
  assert.equal(receipts[1].source_out_condition_line_id, 602);
  assert.equal(receipts[2].productName, receipts[1].productName);
  assert.equal(conditionSearches.length, 2);
  assert.deepEqual(previewIds.sort(), [590, 601, 602]);
});

test("looseNameMatch: 法人格・スペース・大文字小文字のゆれを許し、別名は弾く", () => {
  assert.equal(looseNameMatch("Maldito Games SLU", "Maldito Games"), true);
  assert.equal(looseNameMatch("Broadway Toys Limited", "broadway toys"), true);
  assert.equal(looseNameMatch("株式会社アークライト", "アークライト"), true);
  assert.equal(looseNameMatch("Maldito Games SLU", "Meridian Games"), false);
  assert.equal(looseNameMatch("", "Maldito Games"), false);
});
