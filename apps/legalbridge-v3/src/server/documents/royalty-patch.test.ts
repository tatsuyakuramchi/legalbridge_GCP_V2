import test from "node:test";
import assert from "node:assert/strict";
import {
  bundleEntriesFrom, bundleStatementPatch, multiStatementPatch, receiptAmountLabel,
  receiptConversionLabel, receiptJpyBase, royaltyStatementPatch, singleStatementPatch
} from "./royalty-patch.js";
import { buildTemplateContext } from "./template-context.js";

// ---- 単票 ---------------------------------------------------------------

const numbers = (over: Record<string, any> = {}) => ({
  calcType: "sales" as const, msrp: 1_000_000, quantity: 0, sampleQuantity: 0,
  ratePct: 8, mgAmount: 0, agAmount: 0, agConsumedBefore: 0, taxRatePct: 10,
  grossExTax: 80_000, mgTopupThisTime: 0, mgFloorApplied: false,
  agOffsetThisTime: 0, agRemainingAfter: 0, agFullyConsumed: false,
  actualExTax: 80_000, taxAmount: 8_000, totalIncTax: 88_000, ...over
});

test("単票は V1 と同じ名前・同じ整形で出る", () => {
  const p = singleStatementPatch(numbers());
  assert.equal(p.statementMode, "single");
  assert.equal(p.msrpStr, "1,000,000");
  assert.equal(p.royaltyRatePct, "8");
  assert.equal(p.grossRoyaltyStr, "80,000");
  assert.equal(p.actualRoyaltyStr, "80,000");
  assert.equal(p.taxAmount, "8,000");
  assert.equal(p.totalPaymentStr, "88,000");
  assert.equal(p.taxRate, "10");
});

test("0 は空文字にする（本文の {{#if}} を偽にするため）", () => {
  const p = singleStatementPatch(numbers());
  assert.equal(p.mgAmountStr, "");
  assert.equal(p.agAmountStr, "");
  assert.equal(p.agConsumedThisTimeStr, "");
  assert.equal(p.agApplied, false);
});

test("MG の下限が効いたときは上乗せ額を出す", () => {
  const p = singleStatementPatch(numbers({
    mgAmount: 100_000, mgTopupThisTime: 20_000, mgFloorApplied: true,
    actualExTax: 100_000, taxAmount: 10_000, totalIncTax: 110_000
  }));
  assert.equal(p.mgTopupApplied, true);
  assert.equal(p.mgTopupThisTimeStr, "20,000");
  assert.equal(p.mgAmountStr, "100,000");
  assert.equal(p.actualRoyaltyStr, "100,000");
  // MG は floor なので消化の欄は空のまま（V1 と同じ）。
  assert.equal(p.mgConsumedThisTime, "");
  assert.equal(p.mgFullyConsumed, false);
});

test("AG の充当は前・今回・後と残りが揃う", () => {
  const p = singleStatementPatch(numbers({
    agAmount: 300_000, agConsumedBefore: 100_000, agOffsetThisTime: 80_000,
    agRemainingAfter: 120_000, actualExTax: 0, taxAmount: 0, totalIncTax: 0
  }));
  assert.equal(p.agConsumedBeforeStr, "100,000");
  assert.equal(p.agConsumedThisTimeStr, "80,000");
  assert.equal(p.agConsumedAfterStr, "180,000");
  assert.equal(p.agRemainingStr, "120,000");
  assert.equal(p.agProgressPct, 60);
});

test("製造時等は数量から請求対象数を出す", () => {
  const p = singleStatementPatch(numbers({
    calcType: "manufacturing", msrp: 2_000, quantity: 500, sampleQuantity: 20
  }));
  assert.equal(p.quantity, "500");
  assert.equal(p.sampleQuantity, "20");
  assert.equal(p.billableQuantity, "480");
});

// ---- 多明細 -------------------------------------------------------------

const receipt = (over: Record<string, any> = {}) => ({
  sublicensee: "晨光數位", currency: "USD", amount: 10_000,
  fxMode: "pre" as const, fxRate: 150, ...over
});

test("外貨の入金は入金日レートで円にしてから料率を掛ける", () => {
  assert.equal(receiptJpyBase(receipt()), 1_500_000);
  const p = multiStatementPatch({ receipts: [receipt()], ratePct: 20, taxRatePct: 10 });
  assert.equal(p.linesTotalSalesStr, "1,500,000");
  assert.equal(p.linesTotalPaymentStr, "300,000");
  assert.equal(p.linesTaxStr, "30,000");
  assert.equal(p.linesTotalIncTaxStr, "330,000");
});

test("円転済みの入金は円額をそのまま基礎にする", () => {
  const row = receipt({ fxMode: "post", currency: "JPY", amount: 1_234_567, fxRate: 0 });
  assert.equal(receiptJpyBase(row), 1_234_567);
  assert.equal(receiptConversionLabel(row), "交換後（円転済み）");
  assert.equal(receiptAmountLabel(row), "¥1,234,567");
});

test("換算の根拠は行ごとに書き残す", () => {
  assert.equal(receiptConversionLabel(receipt()), "交換前 → 入金日レート 150");
  assert.equal(receiptConversionLabel(receipt({ currency: "JPY" })), "JPY 入金（レート不要）");
  assert.equal(receiptAmountLabel(receipt()), "USD 10,000");
});

test("多明細は受領情報の表と契約ごとのまとまりを両方出す", () => {
  const p = multiStatementPatch({
    receipts: [receipt(), receipt({ sublicensee: "B社", amount: 2_000 })],
    ratePct: 20, contractTitle: "英語版 出版許諾", contractNumber: "CL-2026-00041"
  });
  const groups = p.lineGroups as Array<Record<string, any>>;
  assert.equal(groups.length, 1);
  assert.equal(groups[0].contractNumber, "CL-2026-00041");
  assert.equal(groups[0].lines.length, 2);
  assert.equal((p.receiptRows as unknown[]).length, 2);
  assert.equal(p.statementMode, "multi");
});

// ---- 束ね ---------------------------------------------------------------

test("束ねは契約ごとに単票と同じ計算をして1枚にまとめる", () => {
  const entries = bundleEntriesFrom({
    rs_bundle: [
      { conditionId: 1, contractTitle: "A契約", contractNumber: "CL-1", conditionName: "電子書籍",
        calcType: "period", basisKind: "sales", msrp: 1_000_000, ratePct: 8,
        periodFrom: "2026-04-01", periodTo: "2026-06-30" },
      { conditionId: 2, contractTitle: "B契約", contractNumber: "CL-2", conditionName: "グッズ",
        calcType: "event", msrp: 2_000, quantity: 500, sampleQuantity: 20, ratePct: 5 },
      { contractTitle: "空", msrp: 0 }
    ]
  });
  assert.equal(entries.length, 3);
  const p = bundleStatementPatch({ entries, taxRatePct: 10 });
  const groups = p.lineGroups as Array<Record<string, any>>;
  assert.equal(groups.length, 2, "基準額の無い行は載せない");
  assert.equal(groups[0].methodLabel, "売上報告ベース");
  assert.equal(groups[1].methodLabel, "製造数量ベース");
  assert.match(String(groups[0].lines[0].basisNote), /算定期間 2026-04-01〜2026-06-30/);
  assert.match(String(groups[1].lines[0].basisNote), /480個 × 基準価格/);
  // 1,000,000×8% = 80,000 ／ 480×2,000×5% = 48,000
  assert.equal(p.linesTotalPaymentStr, "128,000");
  assert.equal(p.linesTaxStr, "12,800");
  assert.equal(p.statementMode, "multi", "本文は多明細と同じ形で描く");
});

// ---- 入口 ---------------------------------------------------------------

const ctx = (over: Record<string, any> = {}) => ({
  condition: {
    id: 1, name: "英語版 出版許諾", conditionNo: "CL-2026-00041", kind: "license",
    direction: "out", pricingModel: "revenue_share", ratePct: 8,
    mgAmount: 100_000, agAmount: 300_000, taxCategory: "taxable"
  },
  conditions: [{ id: 1, taxCategory: "taxable" }],
  agreement: { no: "AG-1", title: "出版許諾契約" },
  royalty: {
    salesInput: 1_000_000, quantity: null, grossExTax: 80_000, mgTopup: 20_000,
    agOffset: 0, agRemaining: 300_000, agConsumedBefore: 0,
    netExTax: 100_000, taxAmount: 10_000, totalIncTax: 110_000
  },
  ...over
});

test("試算があれば計算書の金額が全部埋まる", () => {
  const p = royaltyStatementPatch(ctx(), {}, 10);
  assert.ok(p);
  assert.equal(p.grossRoyaltyStr, "80,000");
  assert.equal(p.mgTopupThisTimeStr, "20,000");
  assert.equal(p.actualRoyaltyStr, "100,000");
  assert.equal(p.totalPaymentStr, "110,000");
  assert.equal(p.royaltyRatePct, "8");
  assert.equal(p.msrpStr, "1,000,000");
});

test("試算が無ければ何も作らない（手入力の下書きをそのまま通す）", () => {
  assert.equal(royaltyStatementPatch({ condition: {} }, {}, 10), null);
});

test("入金明細を入れたら多明細として組む", () => {
  const p = royaltyStatementPatch(ctx(), {
    statementMode: "multi",
    rs_receipts: [{ sublicensee: "晨光數位", currency: "USD", amount: 10000, fxMode: "pre", fxRate: 150 }],
    rsInRatePct: 20
  }, 10);
  assert.ok(p);
  assert.equal(p.statementMode, "multi");
  assert.equal(p.linesTotalPaymentStr, "300,000");
  const groups = p.lineGroups as Array<Record<string, any>>;
  assert.equal(groups[0].contractNumber, "AG-1", "契約番号は合意から埋まる");
});

test("計算書の文脈はひな形ごとの組み立てから出る", () => {
  const c = buildTemplateContext("royalty_statement", ctx(), {});
  assert.equal(c.grossRoyaltyStr, "80,000");
  assert.equal(c.totalPaymentStr, "110,000");
  assert.equal(c.taxRate, "10");
});

test("時限式は算定期間を備考の先頭に載せる", () => {
  const p = royaltyStatementPatch(ctx(), { rsPeriodFrom: "2026-04-01", rsPeriodTo: "2026-06-30" }, 10);
  assert.match(String(p?.notes), /^算定期間: 2026-04-01 〜 2026-06-30/);
});

test("数量の報告があれば製造時等として扱う", () => {
  const p = royaltyStatementPatch(
    ctx({ royalty: { ...ctx().royalty, quantity: 500, sampleQuantity: 20 } }), {}, 10);
  assert.equal(p?.calcType, "manufacturing");
  assert.equal(p?.billableQuantity, "480");
});
