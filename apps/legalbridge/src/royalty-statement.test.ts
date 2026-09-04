import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMultiStatementPatch, buildSingleStatementPatch,
  buildBundleStatementPatch, receiptAmountLabel, receiptConversionLabel, receiptJpyBase, statementMoney,
  structuredStatementPatch, toNumber
} from "./royalty-statement.js";

// 単票（イベント式・製造）: V1 onPreview パッチと同じフィールド・同じ 0=空文字規約。

test("単票・製造契機: 数量×基準価格×料率、AG充当と源泉前合計", () => {
  const { fee, patch } = buildSingleStatementPatch({
    calcType: "manufacturing", msrp: 6000, quantity: 3000, sampleQuantity: 100,
    ratePct: 5, agAmount: 300000, agConsumedBefore: 180000, taxRatePct: 10
  });
  // 2900 × 6000 × 5% = 870,000
  assert.equal(fee.gross_ex_tax, 870000);
  assert.equal(patch.billableQuantity, "2900");
  assert.equal(patch.grossRoyaltyStr, "870,000");
  // AG 残 120,000 を全額充当 → 実支払 750,000
  assert.equal(patch.agApplied, true);
  assert.equal(patch.agConsumedThisTimeStr, "120,000");
  assert.equal(patch.agFullyConsumed, true);
  assert.equal(patch.agProgressPct, 100);
  assert.equal(patch.actualRoyaltyStr, "750,000");
  assert.equal(patch.taxAmount, "75,000");
  assert.equal(patch.totalPaymentStr, "825,000");
  assert.equal(patch.statementMode, "single");
  assert.equal(patch.calcType, "manufacturing");
});

test("単票・時限式(売上報告): MG floor がグロスを下回りに適用される", () => {
  const { patch } = buildSingleStatementPatch({
    calcType: "sales", msrp: 1000000, ratePct: 3, mgAmount: 50000, taxRatePct: 10
  });
  // gross = 30,000 < MG 50,000 → MG 採用（+20,000）
  assert.equal(patch.grossRoyaltyStr, "30,000");
  assert.equal(patch.mgTopupApplied, true);
  assert.equal(patch.mgTopupThisTimeStr, "20,000");
  assert.equal(patch.actualRoyaltyStr, "50,000");
  assert.equal(patch.totalPaymentStr, "55,000");
});

test("単票: MG/AG が 0 のときは空文字で Handlebars の if を false にする", () => {
  const { patch } = buildSingleStatementPatch({
    calcType: "sales", msrp: 100000, ratePct: 5
  });
  assert.equal(patch.mgAmountStr, "");
  assert.equal(patch.agAmountStr, "");
  assert.equal(patch.mgTopupApplied, false);
  assert.equal(patch.agApplied, false);
});

// 多明細: 行ごとの通貨・換算（pre=入金日レートで round、post=円額そのまま）。

const RECEIPTS = [
  { sublicensee: "Meridian Games", currency: "USD", amount: 12000, fxMode: "pre" as const, fxRate: 148.2 },
  { sublicensee: "Seoul Tabletop", currency: "JPY", amount: 890000, fxMode: "post" as const, fxRate: 0.1085 },
  { sublicensee: "台北桌遊社", currency: "JPY", amount: 350000, fxMode: "pre" as const }
];

test("受領行の円換算: pre は round(額×レート)、post/JPY はそのまま", () => {
  assert.equal(receiptJpyBase(RECEIPTS[0]), 1778400);
  assert.equal(receiptJpyBase(RECEIPTS[1]), 890000);
  assert.equal(receiptJpyBase(RECEIPTS[2]), 350000);
});

test("換算・金額の表示ラベル", () => {
  assert.equal(receiptAmountLabel(RECEIPTS[0]), "USD 12,000");
  assert.equal(receiptConversionLabel(RECEIPTS[0]), "交換前 → 入金日レート 148.2");
  assert.equal(receiptConversionLabel(RECEIPTS[1]), "交換後（円転済み）・適用レート 0.1085");
  assert.equal(receiptConversionLabel(RECEIPTS[2]), "JPY 入金（レート不要）");
});

test("多明細: 行ごと ceil で支払額、合計→消費税→源泉前税込", () => {
  const result = buildMultiStatementPatch({
    receipts: RECEIPTS, ratePct: 5, taxRatePct: 10,
    contractTitle: "原作使用許諾（クロノス戦記）", contractNumber: "ARC-IN-2025-0012"
  });
  assert.equal(result.totalSalesJpy, 1778400 + 890000 + 350000);
  // 行ごと: ceil(1,778,400×5%)=88,920 / ceil(890,000×5%)=44,500 / ceil(350,000×5%)=17,500
  assert.equal(result.totalPaymentJpy, 88920 + 44500 + 17500);
  assert.equal(result.tax, Math.ceil(result.totalPaymentJpy * 0.1));
  const groups = result.patch.lineGroups as Array<Record<string, unknown>>;
  assert.equal(groups.length, 1);
  const lines = groups[0].lines as Array<Record<string, unknown>>;
  assert.equal(lines[0].salesJpyStr, "1,778,400");
  assert.equal(lines[0].paymentJpyStr, "88,920");
  assert.equal(lines[0].ratePctResolved, "5");
  assert.equal(groups[0].subtotalPaymentStr, "150,920");
  assert.equal(result.patch.linesTotalIncTaxStr, "166,012");
  // テンプレート拡張用の受領行
  const receiptRows = result.patch.receiptRows as Array<Record<string, unknown>>;
  assert.equal(receiptRows.length, 3);
  assert.equal(receiptRows[0].jpyBaseStr, "1,778,400");
});

test("toNumber はカンマ・円記号・空白を除いて数値化する", () => {
  assert.equal(toNumber("1,778,400"), 1778400);
  assert.equal(toNumber("¥6,000"), 6000);
  assert.equal(toNumber(""), 0);
  assert.equal(toNumber("abc"), 0);
});

// ── 束ね（複数契約を1枚）─────────────────────────────────────────────

test("束ね: 契約ごとに単票と同じ計算（MG floor・AG充当）をして契約ごとの lineGroup と合計にする", () => {
  const { entries, patch, totalPaymentJpy, tax, totalIncTax } = buildBundleStatementPatch({
    taxRatePct: 10,
    entries: [
      { conditionLineId: 501, contractTitle: "原作許諾", contractNumber: "CT-2026-00042", conditionName: "原作ロイヤリティ",
        calcType: "period", basisKind: "sales", msrp: 1000000, quantity: 0, sampleQuantity: 0, ratePct: 3, mgAmount: 50000, agAmount: 0, agConsumedBefore: 0,
        periodFrom: "2026-01-01", periodTo: "2026-06-30" },
      { conditionLineId: 620, contractTitle: "イラスト許諾", contractNumber: "CT-2026-00043", conditionName: "イラスト加算",
        calcType: "event", basisKind: "sales", msrp: 6000, quantity: 3000, sampleQuantity: 100, ratePct: 5, mgAmount: 0, agAmount: 300000, agConsumedBefore: 180000,
        periodFrom: "", periodTo: "" },
      // 基準額が無い行は計算対象外
      { conditionLineId: null, contractTitle: "未入力", contractNumber: "", conditionName: "", calcType: "period", basisKind: "sales",
        msrp: 0, quantity: 0, sampleQuantity: 0, ratePct: 5, mgAmount: 0, agAmount: 0, agConsumedBefore: 0, periodFrom: "", periodTo: "" }
    ]
  });
  assert.equal(entries.length, 2);
  // 契約1: 30,000 < MG 50,000 → 50,000 ／ 契約2: 2900×6000×5% = 870,000 − AG残120,000 = 750,000
  assert.equal(entries[0].fee.actual_ex_tax, 50000);
  assert.equal(entries[1].fee.actual_ex_tax, 750000);
  assert.equal(totalPaymentJpy, 800000);
  assert.equal(tax, 80000);
  assert.equal(totalIncTax, 880000);
  // PDF は多明細レイアウト（lineGroups）で描く
  assert.equal(patch.statementMode, "multi");
  const groups = patch.lineGroups as Array<Record<string, unknown>>;
  assert.equal(groups.length, 2);
  assert.equal(groups[0].contractNumber, "CT-2026-00042");
  assert.equal(groups[0].methodLabel, "売上報告ベース");
  const line0 = (groups[0].lines as Array<Record<string, unknown>>)[0];
  assert.equal(line0.productName, "原作ロイヤリティ");
  assert.equal(line0.salesJpyStr, "1,000,000");
  assert.equal(line0.paymentJpyStr, "50,000");
  assert.match(String(line0.basisNote), /算定期間 2026-01-01〜2026-06-30/);
  assert.match(String(line0.basisNote), /MG適用 \+20,000/);
  const line1 = (groups[1].lines as Array<Record<string, unknown>>)[0];
  assert.equal(line1.salesJpyStr, "17,400,000");
  assert.match(String(line1.basisNote), /AG充当 −120,000/);
  assert.equal(patch.linesTotalPaymentStr, "800,000");
  assert.equal(patch.linesTotalIncTaxStr, "880,000");
});

test("structuredStatementPatch / statementMoney: 単票・多明細・束ね・旧下書きを同じ判定で読む", () => {
  const bundle = structuredStatementPatch({
    statementMode: "bundle", taxRate: "10",
    rs_bundle: [{ conditionLineId: 1, calcType: "period", basisKind: "sales", msrp: "1,000,000", ratePct: 3 }]
  });
  assert.equal(bundle?.linesTotalPaymentStr, "30,000");
  assert.deepEqual(statementMoney({
    statementMode: "bundle", taxRate: "10",
    rs_bundle: [{ conditionLineId: 1, calcType: "period", basisKind: "sales", msrp: 1000000, ratePct: 3 }]
  }), { paymentExTax: 30000, tax: 3000, totalIncTax: 33000 });
  assert.deepEqual(statementMoney({ statementMode: "single", rsCalcType: "period", rsBasisKind: "sales", rsMsrp: 1000000, rsRatePct: 3, taxRate: 10 }),
    { paymentExTax: 30000, tax: 3000, totalIncTax: 33000 });
  // 旧下書き（rs* なし）は印字値から読む
  assert.deepEqual(statementMoney({ actualRoyaltyStr: "999,999", taxAmount: "99,999", totalPaymentStr: "1,099,998" }),
    { paymentExTax: 999999, tax: 99999, totalIncTax: 1099998 });
  assert.equal(structuredStatementPatch({ statementMode: "bundle", rs_bundle: [] }), null);
});
