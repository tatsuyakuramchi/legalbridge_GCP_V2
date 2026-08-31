import assert from "node:assert/strict";
import test from "node:test";
import { isFieldVisible, isInspectionFallbackFieldHidden } from "./field-visibility.js";
import type { TemplateField } from "../types.js";

const base: TemplateField = { name: "X", label: "X" };

test("条件なしの項目は常に表示", () => {
  assert.equal(isFieldVisible(base, {}), true);
  assert.equal(isFieldVisible(base, { anything: "value" }), true);
});

test("anyOf: 参照項目の値が一致したときだけ表示", () => {
  const field: TemplateField = { ...base,
    showWhen: { field: "TRANSACTION_MODEL", anyOf: ["License-Out", "Both"] } };
  assert.equal(isFieldVisible(field, { TRANSACTION_MODEL: "License-Out" }), true);
  assert.equal(isFieldVisible(field, { TRANSACTION_MODEL: "Both" }), true);
  assert.equal(isFieldVisible(field, { TRANSACTION_MODEL: "Product-Out" }), false);
  // 未選択（空・未定義）は非表示 — モデル選択前に両 Schedule を出さない
  assert.equal(isFieldVisible(field, { TRANSACTION_MODEL: "" }), false);
  assert.equal(isFieldVisible(field, {}), false);
});

test("truthy: boolean 項目のチェック有無で表示を切り替える", () => {
  const on: TemplateField = { ...base, showWhen: { field: "ANNEX_1_INCLUDED", truthy: true } };
  assert.equal(isFieldVisible(on, { ANNEX_1_INCLUDED: true }), true);
  assert.equal(isFieldVisible(on, { ANNEX_1_INCLUDED: false }), false);
  assert.equal(isFieldVisible(on, {}), false);
});

test("不正な条件（判定方法なし・field欠落）は表示にフォールバック", () => {
  assert.equal(isFieldVisible({ ...base, showWhen: { field: "Y" } }, {}), true);
  assert.equal(isFieldVisible(
    { ...base, showWhen: { field: "", anyOf: ["a"] } }, {}), true);
});

test("anyOf は文字列化して比較する（数値・真偽値でも落ちない）", () => {
  const field: TemplateField = { ...base, showWhen: { field: "N", anyOf: ["1"] } };
  assert.equal(isFieldVisible(field, { N: 1 }), true);
  assert.equal(isFieldVisible(field, { N: 2 }), false);
});

test("配列は AND：すべての条件を満たしたときだけ表示", () => {
  const field: TemplateField = { ...base, showWhen: [
    { field: "ANNEX_2_INCLUDED", truthy: true },
    { field: "TRANSACTION_MODEL", anyOf: ["Product-Out", "Both"] }
  ] };
  assert.equal(isFieldVisible(field,
    { ANNEX_2_INCLUDED: true, TRANSACTION_MODEL: "Product-Out" }), true);
  assert.equal(isFieldVisible(field,
    { ANNEX_2_INCLUDED: true, TRANSACTION_MODEL: "License-Out" }), false);
  assert.equal(isFieldVisible(field,
    { ANNEX_2_INCLUDED: false, TRANSACTION_MODEL: "Both" }), false);
  assert.equal(isFieldVisible({ ...base, showWhen: [] }, {}), true);
});

test("truthy は配列を件数で見る（明細0件を「明細あり」にしない）", () => {
  const noItems: TemplateField = { ...base, showWhen: { field: "items", truthy: false } };
  // 単一明細フォールバックの項目は、明細が1行も無いときだけ出す。
  assert.equal(isFieldVisible(noItems, {}), true);
  assert.equal(isFieldVisible(noItems, { items: [] }), true);
  assert.equal(isFieldVisible(noItems, { items: [{ item_name: "デザイン" }] }), false);

  const hasItems: TemplateField = { ...base, showWhen: { field: "items", truthy: true } };
  assert.equal(isFieldVisible(hasItems, { items: [] }), false);
  assert.equal(isFieldVisible(hasItems, { items: [{}] }), true);
});

// ── 検収書の単票フォールバック項目の出し分け ─────────────────────────
test("検収明細があれば単票の成果物・金額欄を隠す", () => {
  const withLines = { delivery_line_items: [{ item_name: "A" }] };
  for (const name of ["description", "spec", "deliveredAmountStr", "taxAmountStr", "totalAmountStr"]) {
    assert.equal(isInspectionFallbackFieldHidden("inspection_certificate", name, withLines), true, name);
  }
});

test("税率・軽減税率は明細モードでも使うので隠さない", () => {
  const withLines = { delivery_line_items: [{ item_name: "A" }] };
  assert.equal(isInspectionFallbackFieldHidden("inspection_certificate", "taxRate", withLines), false);
  assert.equal(isInspectionFallbackFieldHidden("inspection_certificate", "isReducedTax", withLines), false);
});

test("明細が無ければ単票フォールバックとして表示する", () => {
  assert.equal(isInspectionFallbackFieldHidden("inspection_certificate", "description", {}), false);
  assert.equal(
    isInspectionFallbackFieldHidden("inspection_certificate", "description", { delivery_line_items: [] }),
    false);
});

test("検収書以外のテンプレートでは何も隠さない", () => {
  assert.equal(isInspectionFallbackFieldHidden("purchase_order", "description",
    { delivery_line_items: [{ item_name: "A" }] }), false);
});

// ── 基本契約の法人専用項目（個人ライセンサーで代表者を必須にしない）──────────
test("license_master: 許諾者が個人なら代表者欄を隠す（必須からも外れる）", async () => {
  const { isCorporateOnlyFieldHidden } = await import("./field-visibility.js");
  assert.equal(isCorporateOnlyFieldHidden("license_master", "VENDOR_REP", { vendorEntityType: "個人" }), true);
  assert.equal(isCorporateOnlyFieldHidden("license_master", "VENDOR_REPRESENTATIVE_SAMA", { vendorEntityType: "個人" }), true);
  assert.equal(isCorporateOnlyFieldHidden("license_master", "VENDOR_REP", { vendorEntityType: "法人" }), false);
  assert.equal(isCorporateOnlyFieldHidden("license_master", "VENDOR_NAME", { vendorEntityType: "個人" }), false);
});

test("license_master: 区分キーは複数を許容し、未入力なら従来どおり必須のまま", async () => {
  const { isCorporateOnlyFieldHidden } = await import("./field-visibility.js");
  assert.equal(isCorporateOnlyFieldHidden("license_master", "VENDOR_REP", { VENDOR_IS_CORPORATION: "個人" }), true);
  assert.equal(isCorporateOnlyFieldHidden("license_master", "VENDOR_REP", { VENDOR_MASTER_ENTITY_TYPE: "individual" }), false);
  // 区分が無い（マスタを使わない手入力）は隠さない＝必須は生きる。
  assert.equal(isCorporateOnlyFieldHidden("license_master", "VENDOR_REP", {}), false);
});

test("license_master 以外のテンプレートでは何も隠さない", async () => {
  const { isCorporateOnlyFieldHidden } = await import("./field-visibility.js");
  assert.equal(isCorporateOnlyFieldHidden("service_master", "VENDOR_REP", { vendorEntityType: "個人" }), false);
});
