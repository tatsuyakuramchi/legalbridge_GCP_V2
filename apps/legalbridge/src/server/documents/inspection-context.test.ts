import assert from "node:assert/strict";
import test from "node:test";
import { buildTemplateDocumentContext } from "./template-context-adapters.js";

// 検収書の合計（納品額・消費税額・合計額）。テンプレートは明細モードでも
// deliveredAmountStr / taxAmountStr / totalAmountStr を合計行に使うのに、
// これまで明細からは生成していなかった＝親POから明細を引用しても合計は
// 手入力しないと空のままだった。明細があれば明細から計算し、手入力より優先する
// （発注書と同じ「画面と PDF の合計を必ず一致させる」規則）。

const LINES = [
  { item_name: "キービジュアル", inspected_amount_ex_tax: 100000 },
  { item_name: "ロゴ", inspected_amount_ex_tax: 50000 },
  { item_name: "利用許諾", inspected_amount_ex_tax: 0, calc_method: "ROYALTY" }
];

test("明細があれば納品額・消費税額・合計額を明細から計算する", () => {
  const context = buildTemplateDocumentContext("inspection_certificate", {
    delivery_line_items: LINES, taxRate: "10"
  });
  assert.equal(context.deliveredAmountStr, "150,000");
  assert.equal(context.taxAmountStr, "15,000");
  assert.equal(context.totalAmountStr, "165,000");
});

test("明細があるときは手入力の合計より明細を優先する（画面とPDFのずれ防止）", () => {
  const context = buildTemplateDocumentContext("inspection_certificate", {
    delivery_line_items: LINES, taxRate: "10",
    deliveredAmountStr: "1,000,000", taxAmountStr: "100,000", totalAmountStr: "1,100,000"
  });
  assert.equal(context.deliveredAmountStr, "150,000");
  assert.equal(context.totalAmountStr, "165,000");
});

test("明細が無ければ単票フォールバック＝手入力値をそのまま使う", () => {
  const context = buildTemplateDocumentContext("inspection_certificate", {
    taxRate: "10",
    deliveredAmountStr: "1,000,000", taxAmountStr: "100,000", totalAmountStr: "1,100,000"
  });
  assert.equal(context.deliveredAmountStr, "1,000,000");
  assert.equal(context.taxAmountStr, "100,000");
  assert.equal(context.totalAmountStr, "1,100,000");
});

test("消費税は切り上げ（既存の検収税計算と同じ丸め）", () => {
  const context = buildTemplateDocumentContext("inspection_certificate", {
    delivery_line_items: [{ item_name: "A", inspected_amount_ex_tax: 333 }], taxRate: "10"
  });
  assert.equal(context.taxAmountStr, "34");
  assert.equal(context.totalAmountStr, "367");
});

// 明細ごとの検収状態（ロジック再構成）: 検収済み（過去分）が混ざるときは
// 支払日ごとのグループ表示（useGroupedInspection・配信中テンプレの分岐）を組み立てる。

test("検収済み行が混ざると支払日ごとのグループ表示になる（グループ別に消費税）", () => {
  const context = buildTemplateDocumentContext("inspection_certificate", {
    taxRate: "10", paymentDueDate: "2026-09-30",
    delivery_line_items: [
      { item_name: "キービジュアル", inspection_status: "paid", inspected_amount_ex_tax: 100000,
        paid_date: "2026-08-31", delivery_date: "2026-07-31" },
      { item_name: "ロゴ", inspection_status: "now", inspected_amount_ex_tax: 25000,
        ordered_amount_ex_tax: 30000, change_reason: "仕様簡素化による減額合意", delivery_date: "2026-08-15" },
      { item_name: "原型", inspection_status: "skip", inspected_amount_ex_tax: 50000 }
    ]
  });
  assert.equal(context.useGroupedInspection, true);
  const groups = context.paymentGroups as Array<Record<string, unknown>>;
  assert.equal(groups.length, 2);
  // 支払済みグループ（過去分）
  assert.equal(groups[0].date, "2026-08-31");
  assert.equal(groups[0].isPaid, true);
  assert.equal(groups[0].subtotalStr, "100,000");
  assert.equal(groups[0].taxAmountStr, "10,000");
  assert.equal(groups[0].totalIncTaxStr, "110,000");
  // 支払予定グループ（今回検収・文書の支払予定日）
  assert.equal(groups[1].date, "2026-09-30");
  assert.equal(groups[1].isPaid, false);
  assert.equal(groups[1].subtotalStr, "25,000");
  const planLines = groups[1].lines as Array<Record<string, unknown>>;
  assert.equal(planLines[0].hasChange, true);
  assert.equal(planLines[0].changeLabel, "支払対価 ¥30,000 → ¥25,000");
  assert.equal(planLines[0].changeNote, "仕様簡素化による減額合意");
  // 支払額（delivered）は今回検収のみ・skip は明細から消える
  assert.equal(context.deliveredAmountStr, "25,000");
  assert.equal((context.delivery_line_items as unknown[]).length, 1);
});

test("今回検収のみなら従来の詳細表＋金額変更は変更履歴に自動起票", () => {
  const context = buildTemplateDocumentContext("inspection_certificate", {
    taxRate: "10", inspectionCompletedAt: "2026-08-18",
    delivery_line_items: [
      { item_name: "ロゴ", inspection_status: "now", inspected_amount_ex_tax: 25000,
        ordered_amount_ex_tax: 30000, change_reason: "減額合意" }
    ]
  });
  assert.equal(context.useGroupedInspection, false);
  assert.equal(context.hasChangeLogs, true);
  const logs = context.changeLogs as Array<Record<string, unknown>>;
  assert.equal(logs[0].fieldLabel, "ロゴ 支払対価");
  assert.equal(logs[0].beforeValue, "¥30,000");
  assert.equal(logs[0].afterValue, "¥25,000");
  assert.equal(logs[0].reason, "減額合意");
});

test("未検収だけ外れる（状態なしの旧下書きは全行そのまま）", () => {
  const context = buildTemplateDocumentContext("inspection_certificate", {
    taxRate: "10",
    delivery_line_items: [
      { item_name: "A", inspected_amount_ex_tax: 10000 },
      { item_name: "B", inspection_status: "skip", inspected_amount_ex_tax: 99999 }
    ]
  });
  assert.equal(context.useGroupedInspection, false);
  assert.equal((context.delivery_line_items as unknown[]).length, 1);
  assert.equal(context.deliveredAmountStr, "10,000");
});

// 進捗（検収率・検収済額・発注総額・未検収額）は明細の状態から自動計算する。
// V. 進捗・財務の手入力欄は旧フォームの名残＝明細があるときは計算値が優先。

test("進捗は明細の状態から自動計算（検収済み＋今回検収 vs 発注総額）", () => {
  const context = buildTemplateDocumentContext("inspection_certificate", {
    taxRate: "10", paymentDueDate: "2026-09-30",
    // 手入力の古い値が残っていても計算値が勝つ
    inspectedPct: "1", inspectedAmountStr: "9", totalOrderAmountStr: "9", pendingAmountStr: "9",
    delivery_line_items: [
      { item_name: "済", inspection_status: "paid", inspected_amount_ex_tax: 100000,
        ordered_amount_ex_tax: 100000, paid_date: "2026-08-31" },
      { item_name: "今回", inspection_status: "now", inspected_amount_ex_tax: 25000,
        ordered_amount_ex_tax: 30000 },
      { item_name: "未", inspection_status: "skip", ordered_amount_ex_tax: 50000 }
    ]
  });
  assert.equal(context.totalOrderAmountStr, "180,000");   // 発注総額（未検収も含む）
  assert.equal(context.inspectedAmountStr, "125,000");    // 済 100,000 + 今回 25,000
  assert.equal(context.pendingAmountStr, "55,000");       // 180,000 − 125,000
  assert.equal(context.inspectedPct, 69);
});
