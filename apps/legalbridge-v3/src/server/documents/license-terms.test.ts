import test from "node:test";
import assert from "node:assert/strict";
import {
  FIXED_DEALS, LICENSE_TERMS_VARIABLES, dealIdFor, dealInUse, dealSeeds,
  isLicenseTermsTemplate, licenseScopeSentence, licenseTermsPatch, licenseTermsSeeds,
  licenseTermsSuggestions, materialSeeds
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
  // 当たる条件が無い形態も行は残すが、載せない。範囲は上限を置く。
  assert.equal(deals[2].conditionNo, undefined);
  assert.equal(deals[2].use, false);
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
  // 条件明細が当たった2種だけ載る（自社製造・他社販売は当たらないので出ない）。
  assert.equal(patch.conds.length, 2);
  assert.equal(patch.conds[0].appliedRate, "7%", "5% + 2%");
  assert.equal(patch.conds[1].appliedRate, "50%");
  assert.equal(patch.conds[0].calcModel, "基準価格×個数×料率");
  assert.equal(patch.conds[0].condType, "【加算型】");
});

test("本文：権利元が複数なら権利元の列を出し、列数を数え直す", () => {
  const patch = licenseTermsPatch(context, {});
  assert.equal(patch.showHolder, true);
  assert.equal(patch.scopeColCount, 6);
  assert.equal(patch.rateColCount, 3, "2 + 載せる加算型 1 件");
  assert.deepEqual(patch.lcs[0].addonRates, ["5%"]);
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

test("サブライセンシーと特記事項はそのまま本文へ渡す（種は空・欄は要る）", () => {
  // V3 のデータからは導けない（相手が決まる前に書く）。種は空だが、欄が無いと
  // 本文の表を埋める手段がどこにも無くなる。
  const seeds = licenseTermsSeeds(context);
  assert.deepEqual(seeds.v3_sublicensees, []);
  assert.deepEqual(seeds.v3_special_extras, []);

  const patch = licenseTermsPatch(context, {
    v3_sublicensees: [{ slPartner: "サブA社", slRegion: "北米", slRate: "50" }],
    v3_special_extras: [{ seId: "1", seText: "監修は毎回受ける" }]
  });
  assert.equal(patch.sublicensees.length, 1);
  assert.equal(patch.sublicensees[0].slPartner, "サブA社");
  assert.equal(patch.specialExtras[0].seText, "監修は毎回受ける");
});

test("本文が差す名前を全部供給する（本番のひな形から採った一覧との突き合わせ）", () => {
  // 本番の individual_license_terms_v3 が差している名前（2026-09-10 時点）。
  // 行の中で差すものは、その行を作っている側で確かめる。
  const patch = licenseTermsPatch(context, {
    v3_sublicensees: [{ slPartner: "サブA社", slRegion: "北米", slLang: "英語",
                        slCond: "権利許諾", slRate: "50", slDate: "2026-08-01", slNote: "" }],
    v3_special_extras: [{ seId: "1", seText: "特記" }],
    v3_calc_base_rows: [{ edition: "初版", trigger: "発売日", note: "—" }]
  });
  const top = ["contractNo", "issueDate", "startDate", "workId", "masterAgreement",
    "licensorName", "licensorAddress", "licensorRep", "licensorContact",
    "licenseeName", "licenseeAddress", "licenseeRep", "licenseeContact",
    "productName", "productDefinition", "exclusivity", "maxRegion", "maxLanguage",
    "scope", "supervisor", "scopeColCount", "rateColCount"];
  for (const name of top) assert.ok(name in patch, `${name} を供給していない`);

  for (const name of ["condLabel", "condName", "condType", "calcModel", "condRegion",
                      "condLang", "appliedRate", "quantity", "ag", "mg", "currency", "basePrice"]) {
    assert.ok(name in patch.conds[0], `conds に ${name} が無い`);
  }
  for (const name of ["lcId", "lcName", "lcHolder", "lcRegion", "lcLanguage", "lcSourceDoc"]) {
    assert.ok(name in patch.lcs[0], `lcs に ${name} が無い`);
  }
  for (const name of ["edition", "trigger", "note"]) {
    assert.ok(name in patch.calcBaseRows[0], `calcBaseRows に ${name} が無い`);
  }
  for (const name of ["slPartner", "slRegion", "slLang", "slCond", "slRate", "slDate", "slNote"]) {
    assert.ok(name in patch.sublicensees[0], `sublicensees に ${name} が無い`);
  }
  for (const name of ["seId", "seText"]) {
    assert.ok(name in patch.specialExtras[0], `specialExtras に ${name} が無い`);
  }
});

test("取引形態は許諾するぶんだけ載せる（再許諾しかない案件に自社製造の行を出さない）", () => {
  const only = {
    ...context,
    conditions: [{ id: 8, conditionNo: "CL-2026-00051", name: "再許諾", direction: "out",
                   pricingModel: "revenue_rate", ratePct: 50, currency: "JPY",
                   mgAmount: 0, agAmount: 0, scopes: { region: ["全世界"], language: [] } }]
  };
  const deals = dealSeeds(only);
  assert.deepEqual(deals.map((d) => d.use), [false, true, false]);

  const patch = licenseTermsPatch(only, {});
  assert.equal(patch.conds.length, 1);
  assert.equal(patch.conds[0].condName, "権利許諾（サブライセンス）");
  // 加算型が1つも載らないので、構成要素の料率の列も出ない。
  assert.equal(patch.rateColCount, 2);
  assert.deepEqual(patch.lcs[0].addonRates, []);
});

test("条件明細が1つも当たらないときは3種とも出して人に選ばせる", () => {
  const deals = dealSeeds({ conditions: [], acquisitions: [] });
  assert.deepEqual(deals.map((d) => d.use), [true, true, true]);
});

test("載せない形態の値は消さない（載せ直せば戻る）", () => {
  const deals: Array<Record<string, any>> =
    dealSeeds(context).map((d) => ({ ...d, use: d.id === 2 }));
  const patch = licenseTermsPatch(context, { v3_conds: deals });
  assert.equal(patch.conds.length, 1);
  // 行そのものは残っているので、載せ直せば地域も料率もそのまま。
  assert.equal(deals[0].reg, "日本");
});

test("use が無い行は載せる扱い（手で足した行・古い下書きを落とさない）", () => {
  assert.equal(dealInUse({ name: "自由記載" }), true);
  assert.equal(dealInUse({ name: "自由記載", use: false }), false);
  const patch = licenseTermsPatch(context, {
    v3_conds: [{ id: 9, name: "自由記載", addon: false, fixedRate: "3" }]
  });
  assert.equal(patch.conds.length, 1);
  assert.equal(patch.conds[0].appliedRate, "3%");
});

// ---------------------------------------------------------------------------
// 許諾範囲の文案
// ---------------------------------------------------------------------------

test("地域・言語・独占性から許諾範囲の文を組む", () => {
  const sentence = licenseScopeSentence({ condition: { sublicensable: false } }, {
    v3_maxRegion: "台湾、香港", v3_maxLanguage: "繁体中国語",
    対象製品予定名: "星降る夜のミュゼ ボードゲーム版", 独占性: "非独占"
  });
  assert.match(sentence, /台湾、香港における繁体中国語/);
  assert.match(sentence, /星降る夜のミュゼ ボードゲーム版/);
  assert.match(sentence, /非独占とする/);
  assert.match(sentence, /再許諾することができない/);
});

test("再許諾できる条件なら、その旨を書く（書かないと不可と読まれる）", () => {
  const sentence = licenseScopeSentence({ condition: { sublicensable: true } },
    { v3_maxRegion: "全世界", v3_maxLanguage: "全言語" });
  assert.match(sentence, /再許諾することができる/);
});

test("地域も言語も決まっていなければ文を作らない（中身の無い文を紙に載せない）", () => {
  assert.equal(licenseScopeSentence({}, { 対象製品予定名: "何か" }), "");
  assert.deepEqual(licenseTermsSuggestions({}, {}), {});
});

test("片方だけ決まっていれば、もう片方は無制限として書く", () => {
  const sentence = licenseScopeSentence({}, { v3_maxRegion: "日本" });
  assert.match(sentence, /日本における全言語/);
});
