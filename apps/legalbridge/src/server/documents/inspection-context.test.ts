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
