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
  assert.equal(royaltyFormulaText("pub_digital", 15, 1), "電子版：甲の受領額 × 15％");
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
    sublicense: "consent"
  });
  assert.match(text, /^特約（初版の利用許諾料を報酬として支払う旨の特則）/);
  assert.match(text, /1\. 本業務のうち原稿およびイラストの制作（以下「本制作」）の対価は、乙が著作権を有する成果物の初版の出版に係る利用許諾料/);
  assert.match(text, /2\. 初版利用許諾料の算定方法は、本体価格（税抜）×（初版発行部数 − 献本・見本等の非加算部数100部）× 10％ とする。本発注書記載の金額（金290,000円。以下「仮計算額」）は、本体価格1,000円・初版3,000部の見込みによる仮計算である（内訳：原稿 金240,000円、イラスト 金50,000円）。/);
  assert.match(text, /3\. 甲は、成果物を受領した日から45日以内に、本体価格および初版発行部数を乙に書面（電磁的方法を含む）で通知し、乙の確認を得て初版利用許諾料の額を確定する。確定額が仮計算額を下回るときは、仮計算額をもって確定額とする。/);
  assert.match(text, /4\. 甲は、成果物を受領した日から60日以内である2027年1月25日までに、確定額を支払う。同日までに確定しないときは、同日までに仮計算額を支払い、確定後の差額を確定の日から30日以内に追加して支払う。/);
  assert.match(text, /5\. 第2版以降の出版および電子版の配信に係る利用許諾料は、甲乙間の出版基本契約（AGR-2026-0088 出版基本契約）に基づく個別契約として締結する個別出版条件書の定めによる（紙版：本体価格 ×（発行部数 − 発行部数の1％にあたる献本等の非加算部数）× 10％、電子版：甲の受領額 × 15％）。/);
  assert.match(text, /本制作の委託（成果物の制作・納入・検収）については業務委託基本契約約款による/);
  assert.match(text, /成果物の第三者への再許諾（翻訳出版等）は、乙の事前の書面による同意を得て行い、その条件（再許諾先・料率・範囲）は個別出版条件書で定める。/);
  assert.match(inLieuSpecialTerms({ deliverables: [{ name: "原稿", amount: 1 }], firstEdition: { price: 1, copies: 1, ratePct: 100 }, laterRates: [], sublicense: "no" }),
    /再許諾（翻訳出版等）は行わない。/);
  assert.match(inLieuSpecialTerms({ deliverables: [{ name: "原稿", amount: 1 }], firstEdition: { price: 1, copies: 1, ratePct: 100 }, laterRates: [], sublicense: "covered" }),
    /本特約により乙の同意を得たものとし/);
  assert.match(text, /6\. 甲は、成果物を利用するに際し、次のクレジット表記を行う。[^\n]*\n　© 2026 山田太郎／イラスト：山田太郎/);
  assert.match(text, /8\. 甲および乙は/);
  assert.doesNotMatch(text, /保証利用許諾料|既払い|相殺/, "AG 相殺型の言い方は使わない");
  // 非加算なし・契約なし・クレジットなし・期日未定：仮計算額は式から、「出版基本契約があるときは」の形、項は 7 つ
  const plain = inLieuSpecialTerms({ deliverables: [{ name: "原稿", amount: 300000 }],
    firstEdition: { price: 1000, copies: 3000, ratePct: 10 }, laterRates: [{ usageType: "pub_print", ratePct: 10 }] });
  assert.match(plain, /算定方法は、本体価格（税抜）× 初版発行部数 × 10％ とする。本発注書記載の金額（金300,000円/);
  assert.match(plain, /受領した日から45日以内に/);
  assert.match(plain, /60日以内である本発注書記載の支払期日までに/);
  assert.match(plain, /甲乙間に出版基本契約があるときは、本特約に定める利用許諾の条件と個別出版条件書をその個別契約として取り扱う/);
  assert.match(plain, /7\. 甲および乙は/);
  assert.doesNotMatch(plain, /内訳|クレジット表記|非加算部数/);
});

test("60 日以内の判定：当日・60 日目は可、61 日目と受領前は不可、日付が無ければ判定しない", () => {
  assert.equal(withinSixtyDays("2026-11-30", "2027-01-29"), true, "60 日目");
  assert.equal(withinSixtyDays("2026-11-30", "2027-01-30"), false, "61 日目");
  assert.equal(withinSixtyDays("2026-11-30", "2026-11-29"), false, "受領の前");
  assert.equal(withinSixtyDays(null, "2026-12-25"), null);
  assert.equal(withinSixtyDays("2026-11-30", ""), null);
});
