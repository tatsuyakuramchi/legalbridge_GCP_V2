import test from "node:test";
import assert from "node:assert/strict";
import {
  FIXED_DEALS, LICENSE_TERMS_VARIABLES, assignDeals, dealIdFor, dealInUse, dealSeeds,
  dealModelFromNotes, isLicenseTermsTemplate, roleOfPart, licenseScopeSentence, licenseTermsPatch,
  licenseTermsSeeds, licenseTermsSuggestions, materialSeeds
} from "./license-terms.js";

/**
 * 本番のデータの形に合わせてある（2026-09-11 に確認）。
 *
 *   ・条件はすべて direction="in"（原作から当社が受ける許諾）
 *   ・同じ素材に、取引形態のぶんだけ条件明細が並ぶ（2% / 50% / 2%）
 *   ・取引形態は備考に文字列で残っている。計算方式は3種とも revenue_rate で、
 *     そのまま見ると全部「権利許諾」になってしまう
 */
const cond = (over: Record<string, any>) => ({
  direction: "in", kind: "license", pricingModel: "revenue_rate", currency: "JPY",
  mgAmount: 0, agAmount: 0, notes: null,
  scopes: { region: [] as string[], language: [] as string[] }, ...over
});

const context = {
  owner: { name: "浅井 崇", phone: "03-5555-6666", email: "asai@example.test" },
  conditions: [
    // 素材1。取引形態3種ぶん並ぶ（備考に形態が書いてある）。
    cond({ id: 21, conditionNo: "CL-2026-00321", name: "ito_イラスト", workPartId: 7,
      work: { title: "ito", part: "ito_イラスト", partType: "illustration" }, ratePct: 2, mgAmount: 100000,
      notes: "取引形態: 自社製造・自社販売 / 計算モデル: 基準価格 × 個数 × 料率",
      scopes: { region: ["日本"], language: ["日本語"] },
      counterparty: { name: "株式会社オリジナル" } }),
    cond({ id: 22, conditionNo: "CL-2026-00322", name: "ito_イラスト", workPartId: 7,
      work: { title: "ito", part: "ito_イラスト", partType: "illustration" }, ratePct: 50,
      notes: "取引形態: 権利許諾（サブライセンス） / 計算モデル: 実効料率（基準価格 × 料率）",
      scopes: { region: ["全世界"], language: [] },
      counterparty: { name: "株式会社オリジナル" } }),
    cond({ id: 23, conditionNo: "CL-2026-00323", name: "ito_イラスト", workPartId: 7,
      work: { title: "ito", part: "ito_イラスト", partType: "illustration" }, ratePct: 2,
      notes: "取引形態: 自社製造・他社販売 / 計算モデル: 供給価格 × 個数 × 料率",
      counterparty: { name: "株式会社オリジナル" } }),
    // 素材2。備考が無いので並び順で当てる（V3 で起こした条件）。
    cond({ id: 31, conditionNo: "CL-2026-00331", name: "追加イラスト", workPartId: 9,
      work: { title: "ito", part: "追加イラスト", partType: "illustration" }, ratePct: 5,
      counterparty: { name: "合同会社アトリエ蒼" } })
  ],
  acquisitions: [
    { id: 21, conditionNo: "CL-2026-00321", name: "ito_イラスト", partName: "ito_イラスト",
      counterparty: "株式会社オリジナル", agreementNo: "ARC-ILT-2026-0030",
      ratePct: 2, regions: ["日本"], languages: ["日本語"] },
    { id: 31, conditionNo: "CL-2026-00331", name: "追加イラスト", partName: "追加イラスト",
      counterparty: "合同会社アトリエ蒼", agreementNo: null,
      ratePct: 5, regions: [], languages: [] }
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

test("取引形態は備考から読む（計算方式は3種とも revenue_rate で当てにならない）", () => {
  assert.equal(dealModelFromNotes("取引形態: 自社製造・自社販売 / 計算モデル: 基準価格 × 個数 × 料率"), 1);
  assert.equal(dealModelFromNotes("取引形態: 権利許諾（サブライセンス） / 計算モデル: 実効料率"), 2);
  assert.equal(dealModelFromNotes("取引形態: 自社製造・他社販売 / 計算モデル: 供給価格 × 個数 × 料率"), 3);
  assert.equal(dealModelFromNotes("取引形態：自社製造・自社販売"), 1, "全角コロンも読む");
  assert.equal(dealModelFromNotes("ただの備考"), null);
  assert.equal(dealModelFromNotes(null), null);
  assert.equal(dealIdFor(context.conditions[1]), 2);
});

test("備考の無い条件は、3種そろっている素材だけ並び順で当てる", () => {
  const assigned = assignDeals(context.conditions);
  assert.equal(assigned.get(21), 1);
  assert.equal(assigned.get(22), 2);
  assert.equal(assigned.get(23), 3);
  // 素材2は備考が無く1本しかない。順番からは形態を決められないので当てない。
  assert.equal(assigned.get(31), undefined);

  const three = assignDeals([
    { id: 1, conditionNo: "A", agreementId: 5, workPartId: 7, ratePct: 2 },
    { id: 2, conditionNo: "B", agreementId: 5, workPartId: 7, ratePct: 50 },
    { id: 3, conditionNo: "C", agreementId: 5, workPartId: 7, ratePct: 2 }
  ]);
  assert.deepEqual([three.get(1), three.get(2), three.get(3)], [1, 2, 3]);
});

test("同じ素材でも契約が違えば別の行にする（根拠文書が違う）", () => {
  const rows = materialSeeds({ conditions: [
    { id: 1, conditionNo: "CL-1", agreementId: 30, workPartId: 7, ratePct: 2,
      work: { part: "ito_イラスト" }, notes: "取引形態: 自社製造・自社販売" },
    { id: 2, conditionNo: "CL-2", agreementId: 33, workPartId: 7, ratePct: 3,
      work: { part: "ito_イラスト" }, notes: "取引形態: 自社製造・自社販売" }
  ], acquisitions: [] });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.rates), [{ "1": "2" }, { "1": "3" }]);
});

test("備考で決まった形態を、並び順の推定が奪わない", () => {
  const assigned = assignDeals([
    { id: 1, ratePct: 2, workPartId: 7, notes: null },
    { id: 2, ratePct: 50, workPartId: 7,
      notes: "取引形態: 権利許諾（サブライセンス） / 計算モデル: 実効料率" },
    { id: 3, ratePct: 2, workPartId: 7, notes: null }
  ]);
  assert.equal(assigned.get(2), 2, "備考が先");
  assert.deepEqual([assigned.get(1), assigned.get(3)], [1, 3], "残りは空いている形態へ順に");
});

test("取引形態の種：条件明細の範囲・MG・AG・通貨を重ねる", () => {
  const deals = dealSeeds(context);
  assert.equal(deals.length, 3);
  assert.equal(deals[0].conditionNo, "CL-2026-00321");
  assert.equal(deals[0].reg, "日本");
  assert.equal(deals[0].lang, "日本語");
  assert.equal(deals[0].mg, "100000");
  assert.equal(deals[0].assignedFrom, "notes");
  // 非加算型は条件の料率がそのまま実効料率になる。加算型は素材の側に置く。
  assert.equal(deals[1].fixedRate, "50");
  assert.equal(deals[0].fixedRate, "");
  assert.deepEqual(deals.map((d) => d.use), [true, true, true]);
});

test("構成要素の種：条件明細が指す素材で行を立て、加算型の列にだけ料率を置く", () => {
  const materials = materialSeeds(context);
  assert.equal(materials.length, 2, "条件4本でも素材は2つ");
  assert.equal(materials[0].name, "ito_イラスト");
  assert.equal(materials[0].holder, "株式会社オリジナル");
  assert.equal(materials[0].source_doc, "ARC-ILT-2026-0030");
  // 加算型は 1 と 3。非加算型（2）の 50% はここに入れない。
  // 入れると加算型の合計に混ざって 2+50+2 の紙が出る。
  assert.deepEqual(materials[0].rates, { "1": "2", "3": "2" });
  // 素材2は形態が決まっていない（1本しかない）ので料率の置き場所が無い。
  // 画面で形態を選べば入る。
  assert.deepEqual(materials[1].rates, {});
  // 役割は素材の種別で決まる。どちらもイラスト＝追加の要素。
  assert.deepEqual(materials.map((m) => m.role), ["sub", "sub"]);
});

test("本文：加算型は構成要素の料率の合計、非加算型は実効料率", () => {
  const patch = licenseTermsPatch(context, {});
  assert.equal(patch.conds.length, 3);
  assert.equal(patch.conds[0].appliedRate, "2%", "コアの 2% だけ（サブはまだ形態が未定）");
  assert.equal(patch.conds[1].appliedRate, "50%", "非加算型は合算しない");
  assert.equal(patch.conds[2].appliedRate, "2%", "素材1つしか料率を持たない");
  assert.equal(patch.conds[0].calcModel, "基準価格×個数×料率");
  assert.equal(patch.conds[0].condType, "【加算型】");
  assert.equal(patch.conds[1].condType, "【非加算型】");
});

test("非加算型に当たった条件の料率が割れていたら印を付ける", () => {
  const two = { ...context, conditions: [
    ...context.conditions,
    cond({ id: 41, conditionNo: "CL-2026-00341", name: "挿絵", workPartId: 9, agreementId: 5,
      work: { title: "ito", part: "挿絵" }, ratePct: 3,
      notes: "取引形態: 自社製造・自社販売 / 計算モデル: 基準価格 × 個数 × 料率" }),
    cond({ id: 42, conditionNo: "CL-2026-00342", name: "挿絵", workPartId: 9, agreementId: 5,
      work: { title: "ito", part: "挿絵" }, ratePct: 40,
      notes: "取引形態: 権利許諾（サブライセンス） / 計算モデル: 実効料率" })
  ] };
  const deals = dealSeeds(two);
  // 50% と 40% が同じ「権利許諾」に当たっている。どちらを紙に書くかは人が決める。
  assert.equal(deals[1].rateConflict, true);
  assert.equal(deals[0].rateConflict, false, "加算型は素材側に置くので割れない");
});

test("本文：コアロジックを先に、サブコンポーネントを後に並べる", () => {
  const patch = licenseTermsPatch(context, {
    v3_lcs: [
      { name: "追加イラスト", role: "sub", rates: { "1": "5" } },
      { name: "ito_イラスト", role: "core", rates: { "1": "2" } }
    ]
  });
  assert.deepEqual(patch.lcs.map((l: any) => l.lcName), ["ito_イラスト", "追加イラスト"]);
  assert.equal(patch.lcs[0].lcRole, "コアロジック");
  assert.equal(patch.lcs[1].lcRole, "サブコンポーネント");
});

test("本文：権利元が複数なら権利元の列を出し、列数を数え直す", () => {
  const patch = licenseTermsPatch(context, {});
  assert.equal(patch.showHolder, true);
  assert.equal(patch.scopeColCount, 6);
  assert.equal(patch.rateColCount, 4, "2 + 載せる加算型 2 件");
  assert.deepEqual(patch.lcs[0].addonRates, ["2%", "2%"]);
  assert.equal(patch.lcs[0].lcSourceDoc, "ARC-ILT-2026-0030");
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
    conditions: [cond({ id: 8, conditionNo: "CL-2026-00051", name: "再許諾", ratePct: 50,
                        workPartId: 7, work: { part: "ito_イラスト" },
                        notes: "取引形態: 権利許諾（サブライセンス） / 計算モデル: 実効料率",
                        scopes: { region: ["全世界"], language: [] } })]
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

test("構成上の役割は素材の種別から決める（コアロジックは原作のゲームデザイン）", () => {
  assert.equal(roleOfPart({ partType: "game_design", part: "ito_原作ゲームデザイン" }), "core");
  assert.equal(roleOfPart({ partType: "illustration", part: "ito_イラスト" }), "sub");
  assert.equal(roleOfPart({ partType: "scenario", part: "追補" }), "sub");
  // 種別が入っていない素材は名前で見る。
  assert.equal(roleOfPart({ partType: "other", part: "原作ゲームデザイン" }), "core");
  // 台帳の命名規則（2026-09-11 に「原作ゲームデザイン」から改名）。
  assert.equal(roleOfPart({ partType: "other", part: "ito_Original_Core_Logic" }), "core");
  assert.equal(roleOfPart({ partType: null, part: "設定資料" }), "sub");
  assert.equal(roleOfPart({}), "sub", "分からなければサブ（コアを勝手に増やさない）");
});
