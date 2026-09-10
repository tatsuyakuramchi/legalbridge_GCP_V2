import test from "node:test";
import assert from "node:assert/strict";
import {
  FIXED_DEALS, LICENSE_TERMS_VARIABLES, dealIdFor, dealSeeds,
  isLicenseTermsTemplate, licenseTermsPatch, materialSeeds
} from "./license-terms.js";

const context = {
  owner: { name: "浅井 崇", phone: "03-5555-6666", email: "asai@example.test" },
  conditions: [
    { id: 7, conditionNo: "CL-2026-00050", name: "自社製造・自社販売", direction: "out",
      pricingModel: "unit_rate", ratePct: 8, currency: "JPY", mgAmount: 100000, agAmount: 0,
      scopes: { region: ["日本"], language: ["日本語"] } },
    { id: 8, conditionNo: "CL-2026-00051", name: "再許諾", direction: "out",
      pricingModel: "revenue_rate", ratePct: 50, currency: "JPY", mgAmount: 0, agAmount: 0,
      scopes: { region: ["全世界"], language: [] } }
  ],
  acquisitions: [
    { id: 1, conditionNo: "CL-2026-00001", name: "原作ゲーム", partName: "本体ルール",
      counterparty: "株式会社オリジナル", agreementNo: "AGR-2026-0001",
      ratePct: 5, regions: ["全世界"], languages: ["全言語"] },
    { id: 2, conditionNo: "CL-2026-00002", name: "挿絵", partName: "イラスト",
      counterparty: "合同会社アトリエ蒼", agreementNo: null,
      ratePct: 2, regions: ["日本"], languages: ["日本語"] }
  ]
};

test("条件書のひな形だけを見分ける", () => {
  assert.equal(isLicenseTermsTemplate("individual_license_terms_v3"), true);
  assert.equal(isLicenseTermsTemplate("royalty_statement"), false);
});

test("項目の一覧がコードにある（移行では空だったので、これが無いと画面が空になる）", () => {
  assert.ok(LICENSE_TERMS_VARIABLES.length >= 20);
  const names = LICENSE_TERMS_VARIABLES.map((v) => v.name);
  for (const name of ["Licensor_氏名会社名", "Licensee_氏名会社名", "対象製品予定名", "独占性", "許諾開始日"]) {
    assert.ok(names.includes(name), `${name} が無い`);
  }
  // 表は手入力の項目一覧に出さない（専用の編集欄で扱う）。
  for (const name of ["v3_conds", "v3_lcs"]) {
    assert.equal(LICENSE_TERMS_VARIABLES.find((v) => v.name === name)?.type, "array");
  }
});

test("取引形態は固定3種。id は料率マップの鍵なので 1/2/3 のまま", () => {
  assert.deepEqual(FIXED_DEALS.map((d) => d.id), [1, 2, 3]);
  assert.deepEqual(FIXED_DEALS.map((d) => d.addon), [true, false, true]);
});

test("計算方式から取引形態を当てる", () => {
  assert.equal(dealIdFor({ direction: "out", pricingModel: "unit_rate" }), 1);
  assert.equal(dealIdFor({ direction: "out", pricingModel: "revenue_rate" }), 2);
  assert.equal(dealIdFor({ direction: "in", pricingModel: "unit_rate" }), null);
  assert.equal(dealIdFor({ direction: "out", pricingModel: "fixed" }), null);
});

test("取引形態の種：条件明細の範囲・MG・AG・通貨を重ねる", () => {
  const deals = dealSeeds(context);
  assert.equal(deals.length, 3);
  assert.equal(deals[0].conditionNo, "CL-2026-00050");
  assert.equal(deals[0].reg, "日本");
  assert.equal(deals[0].lang, "日本語");
  assert.equal(deals[0].mg, "100000");
  // 非加算型は条件の料率がそのまま実効料率になる。
  assert.equal(deals[1].fixedRate, "50");
  // 当たる条件が無い形態も残す。範囲は上限を置く（未記入と上限なしを混同しない）。
  assert.equal(deals[2].conditionNo, undefined);
  assert.equal(deals[2].reg, "全世界");
  assert.equal(deals[2].lang, "全言語");
});

test("構成要素の種：作品の取得条件から並べ、加算型の形態に同じ料率を置く", () => {
  const materials = materialSeeds(context);
  assert.equal(materials.length, 2);
  assert.equal(materials[0].material_code, "CL-2026-00001");
  assert.equal(materials[0].name, "本体ルール");
  assert.equal(materials[0].holder, "株式会社オリジナル");
  assert.equal(materials[0].source_doc, "AGR-2026-0001");
  // 加算型は 1 と 3。非加算型（2）には置かない。
  assert.deepEqual(materials[0].rates, { "1": "5", "3": "5" });
  assert.equal(materials[1].region, "日本");
});

test("本文：加算型は構成要素の料率の合計、非加算型は実効料率", () => {
  const patch = licenseTermsPatch(context, {});
  assert.equal(patch.conds.length, 3);
  assert.equal(patch.conds[0].appliedRate, "7%", "5% + 2%");
  assert.equal(patch.conds[1].appliedRate, "50%");
  assert.equal(patch.conds[0].calcModel, "基準価格×個数×料率");
  assert.equal(patch.conds[0].condType, "【加算型】");
});

test("本文：権利元が複数なら権利元の列を出し、列数を数え直す", () => {
  const patch = licenseTermsPatch(context, {});
  assert.equal(patch.showHolder, true);
  assert.equal(patch.scopeColCount, 6);
  assert.equal(patch.rateColCount, 4, "2 + 加算型 2 件");
  assert.deepEqual(patch.lcs[0].addonRates, ["5%", "5%"]);
  assert.equal(patch.lcs[0].lcSourceDoc, "AGR-2026-0001");
  assert.equal(patch.lcs[1].lcSourceDoc, "本条件書（新規）", "根拠文書が無ければ新規");
});

test("本文：手で直した表があればそちらを使う", () => {
  const patch = licenseTermsPatch(context, {
    v3_lcs: [{ material_code: "X-1", name: "差し替え", holder: "甲", rates: { "1": "12" } }]
  });
  assert.equal(patch.lcs.length, 1);
  assert.equal(patch.lcs[0].lcName, "差し替え");
  assert.equal(patch.conds[0].appliedRate, "12%");
  assert.equal(patch.showHolder, false, "権利元が1社なら列を出さない");
});

test("本文：算定基準と対象製品の定義は既定を持つ", () => {
  const patch = licenseTermsPatch(context, {});
  assert.deepEqual(patch.calcBaseRows.map((r: any) => r.edition), ["初版", "2版以降"]);
  assert.match(String(patch.productDefinition), /ボードゲーム製品/);
});

test("本文：自社の通知先は担当者から組む", () => {
  const patch = licenseTermsPatch(context, {});
  assert.equal(patch.licenseeContact, "浅井 崇 ／ 03-5555-6666 ／ asai@example.test");
  assert.equal(licenseTermsPatch(context, { Licensee_連絡先: "法務部" }).licenseeContact, "法務部");
});
