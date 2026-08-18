import assert from "node:assert/strict";
import test from "node:test";
import { buildTemplateDocumentContext } from "./template-context-adapters.js";

// 利用許諾料計算書の構造化入力（rs*）→ テンプレート変数の組み立て。
// フォーム再設計後は生の実績値だけを保存し、グロス・MG/AG・合計（*Str）は
// ここで共有エンジンから組み立てる＝右レールの表示と PDF が必ず一致する。
// 旧下書き（rs* なし・手入力の *Str）はそのまま通す（後方互換）。

test("単票・イベント式: rs* からグロス→AG充当→源泉前合計まで組み立てる", () => {
  const context = buildTemplateDocumentContext("royalty_statement", {
    statementMode: "single", rsCalcType: "event",
    rsMsrp: 6000, rsQuantity: 3000, rsSampleQuantity: 100, rsRatePct: 5,
    rsAgAmount: 300000, rsAgConsumedBefore: 180000, taxRate: "10"
  });
  assert.equal(context.calcType, "manufacturing");
  assert.equal(context.billableQuantity, "2900");
  assert.equal(context.grossRoyaltyStr, "870,000");
  assert.equal(context.agApplied, true);
  assert.equal(context.agConsumedThisTimeStr, "120,000");
  assert.equal(context.actualRoyaltyStr, "750,000");
  assert.equal(context.totalPaymentStr, "825,000");
});

test("単票・時限式: 算定期間が備考の先頭に載り、calcType は sales になる", () => {
  const context = buildTemplateDocumentContext("royalty_statement", {
    statementMode: "single", rsCalcType: "period", rsBasisKind: "sales",
    rsMsrp: 1000000, rsRatePct: 3, rsPeriodFrom: "2026-01-01", rsPeriodTo: "2026-06-30",
    notes: "既存の備考", taxRate: "10"
  });
  assert.equal(context.calcType, "sales");
  assert.equal(context.grossRoyaltyStr, "30,000");
  assert.equal(String(context.notes), "算定期間: 2026-01-01 〜 2026-06-30\n既存の備考");
});

test("多明細: 受領行から lineGroups と receiptRows を組み立てる（行ごと換算）", () => {
  const context = buildTemplateDocumentContext("royalty_statement", {
    statementMode: "multi",
    rs_receipts: [
      { sublicensee: "Meridian Games", currency: "USD", amount: 12000, fxMode: "pre", fxRate: 148.2 },
      { sublicensee: "Seoul Tabletop", currency: "JPY", amount: 890000, fxMode: "post", fxRate: 0.1085 }
    ],
    rsInRatePct: 5, taxRate: "10",
    linked_contract_number: "ARC-IN-2025-0012", contractTitle: "原作使用許諾"
  });
  assert.equal(context.statementMode, "multi");
  const groups = context.lineGroups as Array<Record<string, unknown>>;
  assert.equal(groups.length, 1);
  assert.equal(groups[0].contractNumber, "ARC-IN-2025-0012");
  const lines = groups[0].lines as Array<Record<string, unknown>>;
  assert.equal(lines[0].salesJpyStr, "1,778,400");
  assert.equal(lines[0].paymentJpyStr, "88,920");
  const receiptRows = context.receiptRows as Array<Record<string, unknown>>;
  assert.equal(receiptRows.length, 2);
  assert.equal(receiptRows[0].amountStr, "USD 12,000");
  assert.equal(receiptRows[1].jpyBaseStr, "890,000");
  // 合計は行ごと ceil の総和 → 消費税 → 源泉前税込
  assert.equal(context.linesTotalPaymentStr, "133,420");
  assert.equal(context.linesTotalIncTaxStr, "146,762");
});

test("旧下書き（rs* なし）は従来どおり手入力値のまま通る", () => {
  const context = buildTemplateDocumentContext("royalty_statement", {
    statementMode: "single", grossRoyaltyStr: "999,999", actualRoyaltyStr: "999,999",
    lines: [{ productName: "既存明細", sales_amount: 100, royalty_amount: 5 }]
  });
  assert.equal(context.grossRoyaltyStr, "999,999");
  assert.equal(context.actualRoyaltyStr, "999,999");
});
