import test from "node:test";
import assert from "node:assert/strict";
import { exemptCopiesFor, exemptRuleShort, exemptRuleText, inLieuSpecialTerms, royaltyFormulaText, withinSixtyDays }
  from "./royalty-in-lieu.js";

test("印税対象外：初版は定めた部数、2 版目以降は発行部数の割合（切り捨て・発行部数まで）", () => {
  const rule = { firstEditionCopies: 100, laterEditionPct: 1 };
  assert.equal(exemptCopiesFor(rule, 1, 3000), 100);
  assert.equal(exemptCopiesFor(rule, 2, 2550), 25, "2550 × 1% = 25.5 → 25");
  assert.equal(exemptCopiesFor(rule, 1, 60), 60, "発行部数を超えない");
  assert.equal(exemptCopiesFor({ firstEditionCopies: null, laterEditionPct: null }, 1, 3000), 0);
  assert.equal(exemptCopiesFor(null, 2, 3000), 0);
});

test("印税対象外の文：両方・片方・なし", () => {
  assert.equal(exemptRuleText({ firstEditionCopies: 100, laterEditionPct: 1 }),
    "初版は100部、2版目以降は発行部数の1％を献本等として印税の対象外とする");
  assert.equal(exemptRuleText({ firstEditionCopies: 200, laterEditionPct: null }), "初版は200部を献本等として印税の対象外とする");
  assert.equal(exemptRuleText({ firstEditionCopies: null, laterEditionPct: 1.5 }), "発行部数の1.5％を献本等として印税の対象外とする");
  assert.equal(exemptRuleText({ firstEditionCopies: 0, laterEditionPct: 0 }), "");
  assert.equal(exemptRuleShort({ firstEditionCopies: 100, laterEditionPct: 1 }), "対象外：初版100部／2版以降1%");
});

test("算定式：紙は本体価格 × 発行部数、電子は甲の受領額", () => {
  assert.equal(royaltyFormulaText("pub_print", 10), "紙版：本体価格 × 発行部数 × 10％");
  assert.equal(royaltyFormulaText("pub_digital", 15), "電子版：甲の受領額 × 15％");
  assert.equal(royaltyFormulaText("in_house", 8.5), "自社製造・自社販売：甲の受領額 × 8.5％");
});

test("特約の文：成果物の列挙・料率・保証利用許諾料と内訳・支払期日・対象外", () => {
  const text = inLieuSpecialTerms({
    deliverables: [{ name: "原稿", amount: 250000 }, { name: "イラスト", amount: 50000 }],
    rates: [{ usageType: "pub_print", ratePct: 10 }, { usageType: "pub_digital", ratePct: 15 }],
    guaranteeAmount: 300000, payOn: "2026-12-25",
    exempt: { firstEditionCopies: 100, laterEditionPct: 1 }
  });
  assert.match(text, /^特約（制作対価を利用許諾料で支払う旨の特則）/);
  assert.match(text, /本業務のうち原稿およびイラストの制作（以下「本制作」）/);
  assert.match(text, /乙に別途の制作報酬を支払わず/);
  assert.match(text, /　・紙版：本体価格 × 発行部数 × 10％\n　・電子版：甲の受領額 × 15％/);
  assert.match(text, /保証利用許諾料：金300,000円（税抜）（内訳：原稿 金250,000円、イラスト 金50,000円）/);
  assert.match(text, /初版は100部、2版目以降は発行部数の1％を献本等として印税の対象外とする。/);
  assert.match(text, /60日以内である2026年12月25日までに、保証利用許諾料を支払う/);
  assert.match(text, /既払いの印税として扱う/);
  assert.doesNotMatch(text, /金0円|0円とする|報酬の額は0円/, "0 円の記載は入れない（買いたたきの外観）");
  // 1 成果物・期日未定・対象外なし
  const one = inLieuSpecialTerms({ deliverables: [{ name: "原稿", amount: 300000 }],
    rates: [{ usageType: "pub_print", ratePct: 10 }], guaranteeAmount: 300000, payOn: null, exempt: null });
  assert.match(one, /本業務のうち原稿の制作（以下「本制作」）/);
  assert.match(one, /60日以内である本発注書記載の支払期日までに/);
  assert.doesNotMatch(one, /内訳/);
  assert.doesNotMatch(one, /対象外/);
});

test("60 日以内の判定：当日・60 日目は可、61 日目と受領前は不可、日付が無ければ判定しない", () => {
  assert.equal(withinSixtyDays("2026-11-30", "2027-01-29"), true, "60 日目");
  assert.equal(withinSixtyDays("2026-11-30", "2027-01-30"), false, "61 日目");
  assert.equal(withinSixtyDays("2026-11-30", "2026-11-29"), false, "受領の前");
  assert.equal(withinSixtyDays(null, "2026-12-25"), null);
  assert.equal(withinSixtyDays("2026-11-30", ""), null);
});
