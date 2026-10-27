import test from "node:test";
import assert from "node:assert/strict";
import { firstEditionBasisText, firstEditionFee, firstEditionFormulaText, inLieuShortNote, inLieuSpecialTerms,
         royaltyFormulaText, withinSixtyDays } from "./royalty-in-lieu.js";

test("初版利用許諾料の計算：本体価格 ×（部数 − 非加算）× 率。四捨五入。非加算が部数以上なら 0", () => {
  assert.equal(firstEditionFee({ price: 1000, copies: 3000, ratePct: 10 }), 300000);
  assert.equal(firstEditionFee({ price: 1000, copies: 3000, ratePct: 10, exemptCopies: 100 }), 290000);
  assert.equal(firstEditionFee({ price: 1500, copies: 2222, ratePct: 7.5 }), 249975);
  assert.equal(firstEditionFee({ price: 1000, copies: 100, ratePct: 10, exemptCopies: 100 }), 0);
});

test("算定方法と算定の基礎の文：非加算があるときだけ「− ○部」を書く", () => {
  assert.equal(firstEditionFormulaText({ ratePct: 10 }), "本体価格（税抜）× 初版発行部数 × 10％");
  assert.equal(firstEditionFormulaText({ ratePct: 10, exemptCopies: 100 }),
    "本体価格（税抜）×（初版発行部数 − 献本・見本等の非加算部数100部）× 10％");
  assert.equal(firstEditionBasisText({ price: 1000, copies: 3000, ratePct: 10 }),
    "算定の基礎（見込み）：本体価格 1,000円（税抜）× 初版 3,000部 × 10%");
  assert.equal(firstEditionBasisText({ price: 1000, copies: 3200, ratePct: 10, exemptCopies: 100 }, "確定"),
    "算定の基礎（確定）：本体価格 1,000円（税抜）× （初版 3,200部 − 献本等 100部） × 10%");
  assert.equal(inLieuShortNote(100, 1), "初版は明細の初版利用許諾料で支払済み（非加算 100部）／2版以降は発行部数の1%を非加算");
  assert.equal(inLieuShortNote(null, null), "初版は明細の初版利用許諾料で支払済み");
});

test("2 版目以降の算定式：紙は非加算つき、電子は受領額", () => {
  assert.equal(royaltyFormulaText("pub_print", 10, 1), "紙版：本体価格 ×（発行部数 − 発行部数の1％にあたる献本等の非加算部数）× 10％");
  assert.equal(royaltyFormulaText("pub_print", 10, null), "紙版：本体価格 × 発行部数 × 10％");
  assert.equal(royaltyFormulaText("pub_digital", 15, 1), "電子版：発注者の受領額 × 15％");
});

test("特約の文：算定方法・仮計算額・確定の手続き・60 日・2 版目以降・契約・クレジット", () => {
  const text = inLieuSpecialTerms({
    deliverables: [{ name: "原稿", amount: 240000 }, { name: "イラスト", amount: 50000 }],
    firstEdition: { price: 1000, copies: 3000, ratePct: 10, exemptCopies: 100 },
    confirmWithinDays: 45, payOn: "2027-01-25",
    laterRates: [{ usageType: "pub_print", ratePct: 10 }, { usageType: "pub_digital", ratePct: 15 }],
    laterExemptPct: 1,
    masterAgreement: { no: "AGR-2026-0088", title: "出版基本契約" },
    creditNotice: "© 2026 山田太郎／イラスト：山田太郎",
    sublicense: "consent", companionDocument: "pub_terms"
  });
  assert.match(text, /^特約（初版の利用許諾料を報酬として支払う旨の特則）/);
  assert.match(text, /1\. 本業務のうち原稿およびイラストの制作（以下「本制作」）の対価（制作報酬）は、受注者が著作権を有する成果物の初版の出版に係る利用許諾料の算定方法により算定した額（以下「初版利用許諾料」）とし、当該報酬には成果物の初版の出版に係る利用許諾の対価を含む。/);
  assert.match(text, /本制作の業務期間は本発注書記載の期間（納期まで）とし、成果物の利用許諾の期間は本発注書の利用許諾条件に定める期間とする/);
  assert.match(text, /2\. 初版利用許諾料の算定方法は、本体価格（税抜）×（初版発行部数 − 献本・見本等の非加算部数100部）× 10％ とする。本発注書記載の金額（金290,000円。以下「仮計算額」）は、本体価格1,000円・初版3,000部の見込みによる仮計算である（内訳：原稿 金240,000円、イラスト 金50,000円）。/);
  assert.match(text, /3\. 発注者は、成果物を受領した日から45日以内に、本体価格および初版発行部数を受注者に書面（電磁的方法を含む）で通知し、受注者の確認を得て初版利用許諾料の額を確定する。確定した額が仮計算額より多いときは確定した額を、確定した額が仮計算額より少ないときは仮計算額を、それぞれ支払額とする（仮計算額より減額しない）。/);
  assert.match(text, /4\. 発注者は、成果物を受領した日から60日以内である2027年1月25日までに、前項の支払額を支払う。同日までに確定していないときは、同日までに仮計算額を支払い、確定した額が仮計算額より多いときは、その差額を確定の日から30日以内に追加して支払う。/);
  assert.match(text, /5\. 第2版以降の出版および電子版の配信に係る利用許諾料は、発注者と受注者の間の出版基本契約（AGR-2026-0088 出版基本契約）に基づく個別契約として締結する個別出版条件書の定めによる（紙版：本体価格 ×（発行部数 − 発行部数の1％にあたる献本等の非加算部数）× 10％、電子版：発注者の受領額 × 15％）。/);
  assert.match(text, /本制作の委託（成果物の制作・納入・検収）については業務委託基本契約約款による/);
  assert.match(text, /成果物の第三者への再許諾（翻訳出版等）は、受注者の事前の書面による同意を得て行い、その条件（再許諾先・料率・範囲）は個別出版条件書で定める。/);
  assert.match(inLieuSpecialTerms({ deliverables: [{ name: "原稿", amount: 1 }], firstEdition: { price: 1, copies: 1, ratePct: 100 }, laterRates: [], sublicense: "no" }),
    /再許諾（翻訳出版等）は行わない。/);
  assert.match(inLieuSpecialTerms({ deliverables: [{ name: "原稿", amount: 1 }], firstEdition: { price: 1, copies: 1, ratePct: 100 }, laterRates: [], sublicense: "covered" }),
    /本特約により受注者の同意を得たものとし/);
  assert.match(text, /本発注書と併せて締結する出版等利用許諾条件書（出版基本契約（AGR-2026-0088 出版基本契約）に基づく作品追加の合意）に定める条件に当たり/);
  assert.match(inLieuSpecialTerms({ deliverables: [{ name: "原稿", amount: 1 }], firstEdition: { price: 1, copies: 1, ratePct: 100 }, laterRates: [], companionDocument: "license_terms" }),
    /併せて締結する個別利用許諾条件書に定める条件に当たり/);
  assert.match(text, /6\. 発注者は、成果物を利用するに際し、次のクレジット表記を行う。[^\n]*\n　© 2026 山田太郎／イラスト：山田太郎/);
  assert.match(text, /8\. 発注者および受注者は/);
  assert.doesNotMatch(text, /保証利用許諾料|既払い|相殺/, "AG 相殺型の言い方は使わない");
  // 非加算なし・契約なし・クレジットなし・期日未定：仮計算額は式から、「出版基本契約があるときは」の形、項は 7 つ
  const plain = inLieuSpecialTerms({ deliverables: [{ name: "原稿", amount: 300000 }],
    firstEdition: { price: 1000, copies: 3000, ratePct: 10 }, laterRates: [{ usageType: "pub_print", ratePct: 10 }] });
  assert.match(plain, /算定方法は、本体価格（税抜）× 初版発行部数 × 10％ とする。本発注書記載の金額（金300,000円/);
  assert.match(plain, /受領した日から45日以内に/);
  assert.match(plain, /60日以内である本発注書記載の支払期日までに/);
  assert.match(plain, /発注者と受注者の間に出版基本契約があるときは、本特約に定める利用許諾の条件と個別出版条件書をその個別契約として取り扱う/);
  assert.match(plain, /7\. 発注者および受注者は/);
  assert.doesNotMatch(plain, /内訳|クレジット表記|非加算部数/);
  assert.doesNotMatch(plain, /条件に当たり/, "条件書を選んでいなければ書かない");
});

test("60 日以内の判定：当日・60 日目は可、61 日目と受領前は不可、日付が無ければ判定しない", () => {
  assert.equal(withinSixtyDays("2026-11-30", "2027-01-29"), true, "60 日目");
  assert.equal(withinSixtyDays("2026-11-30", "2027-01-30"), false, "61 日目");
  assert.equal(withinSixtyDays("2026-11-30", "2026-11-29"), false, "受領の前");
  assert.equal(withinSixtyDays(null, "2026-12-25"), null);
  assert.equal(withinSixtyDays("2026-11-30", ""), null);
});

test("A-089：条件書の備考の 1 文。算定の基礎があれば括弧で添え、無ければ文だけ", async () => {
  const { inLieuPaidNote } = await import("./royalty-in-lieu.js");
  assert.equal(inLieuPaidNote({ price: 2500, copies: 4000, ratePct: 8, exemptCopies: 100 }),
    "初版の出版に係る利用許諾料は、発注書の制作報酬（初版利用許諾料）として支払済み（算定：本体価格 2,500円（税抜）× （初版 4,000部 − 献本等 100部） × 8%）。本条件書の料率は第2版以降の出版および電子版に適用する。");
  assert.match(inLieuPaidNote(null), /^初版の出版に係る利用許諾料は、発注書の制作報酬（初版利用許諾料）として支払済み。/);
});

test("A-089：特約第1項は、制作報酬を利用許諾料の算定方法で算定し、その報酬に利用許諾の対価を含む構造。業務期間と許諾期間を日付で書く", async () => {
  const { inLieuSpecialTerms } = await import("./royalty-in-lieu.js");
  const text = inLieuSpecialTerms({
    deliverables: [{ name: "原稿", amount: 780000 }],
    firstEdition: { price: 2500, copies: 4000, ratePct: 8, exemptCopies: 100 },
    laterRates: [{ usageType: "pub_print", ratePct: 8 }],
    servicePeriod: { start: "2026-05-15", end: "2026-10-31" },
    licensePeriod: { start: "2026-05-15", end: null }
  });
  assert.match(text, /当該報酬には成果物の初版の出版に係る利用許諾の対価を含む。発注者は、これと別に制作報酬または初版の利用許諾料を支払わない。/);
  assert.match(text, /本制作の業務期間は2026年5月15日から2026年10月31日までとし、成果物の利用許諾の期間は2026年5月15日から（終期の定めなし）とする。/);
});

test("A-091：価格の基準。卸価格（再許諾先への供給価格）なら式と算定の基礎と 2 版目以降の式がそう書かれる", async () => {
  const { priceBasisText, firstEditionFormulaText, firstEditionBasisText, royaltyFormulaText, inLieuSpecialTerms } = await import("./royalty-in-lieu.js");
  assert.equal(priceBasisText(null), "本体価格（税抜）");
  assert.equal(priceBasisText("supply", "KADOKAWA"), "卸価格（KADOKAWA への供給価格・税抜）");
  assert.equal(priceBasisText("supply"), "卸価格（再許諾先への供給価格・税抜）");
  assert.equal(priceBasisText("receipts"), "発注者の受領額");
  assert.equal(firstEditionFormulaText({ ratePct: 8, exemptCopies: 100, priceBasis: "supply", partyName: "KADOKAWA" }),
    "卸価格（KADOKAWA への供給価格・税抜）×（初版発行部数 − 献本・見本等の非加算部数100部）× 8％");
  assert.equal(firstEditionBasisText({ price: 4000, copies: 3000, ratePct: 8, exemptCopies: 100, priceBasis: "supply", partyName: "KADOKAWA" }),
    "算定の基礎（見込み）：卸価格 4,000円（KADOKAWA への供給価格・税抜）× （初版 3,000部 − 献本等 100部） × 8%");
  assert.equal(royaltyFormulaText("pub_print", 8, 1, "supply", "KADOKAWA"),
    "紙版：卸価格（KADOKAWA への供給価格・税抜） ×（発行部数 − 発行部数の1％にあたる献本等の非加算部数）× 8％");
  assert.equal(royaltyFormulaText("pub_print", 8, null), "紙版：本体価格 × 発行部数 × 8％", "空なら従来どおり");
  const text = inLieuSpecialTerms({
    deliverables: [{ name: "原稿", amount: 928000 }],
    firstEdition: { price: 4000, copies: 3000, ratePct: 8, exemptCopies: 100, priceBasis: "supply", partyName: "KADOKAWA" },
    laterRates: [{ usageType: "pub_print", ratePct: 8, priceBasis: "supply", partyName: "KADOKAWA" }]
  });
  assert.match(text, /2\. 初版利用許諾料の算定方法は、卸価格（KADOKAWA への供給価格・税抜）×（初版発行部数 − 献本・見本等の非加算部数100部）× 8％ とする。本発注書記載の金額（金928,000円。以下「仮計算額」）は、卸価格4,000円・初版3,000部の見込みによる仮計算である。/);
  assert.match(text, /3\. 発注者は、成果物を受領した日から45日以内に、卸価格および初版発行部数を受注者に書面/);
  assert.match(text, /紙版：卸価格（KADOKAWA への供給価格・税抜） × 発行部数 × 8％/);
});

test("A-092：受領額基準（再許諾料の入金 × 料率）は部数を掛けない。式・算定の基礎・特約もそう書く", async () => {
  const { firstEditionFee, firstEditionFormulaText, firstEditionBasisText, inLieuSpecialTerms } = await import("./royalty-in-lieu.js");
  const fe = { price: 10_000_000, copies: 1, ratePct: 8, exemptCopies: 0, priceBasis: "receipts" as const, partyName: "KADOKAWA" };
  assert.equal(firstEditionFee(fe), 800_000);
  assert.equal(firstEditionFee({ ...fe, copies: 3000 }), 800_000, "部数があっても掛けない");
  assert.equal(firstEditionFormulaText(fe), "発注者がKADOKAWAから受領する再許諾料（税抜）× 8％");
  assert.equal(firstEditionBasisText(fe), "算定の基礎（見込み）：受領する再許諾料 10,000,000円（税抜）× 8%");
  const text = inLieuSpecialTerms({ deliverables: [{ name: "原稿", amount: 800_000 }], firstEdition: fe,
                                    laterRates: [{ usageType: "pub_print", ratePct: 8, priceBasis: "receipts" }] });
  assert.match(text, /2\. 初版利用許諾料の算定方法は、発注者がKADOKAWAから受領する再許諾料（税抜）× 8％ とする。本発注書記載の金額（金800,000円。以下「仮計算額」）は、受領する再許諾料10,000,000円の見込みによる仮計算である。/);
  assert.match(text, /3\. 発注者は、成果物を受領した日から45日以内に、受領する再許諾料の額を受注者に書面/);
  assert.match(text, /紙版：発注者の受領額 × 8％/);
});
