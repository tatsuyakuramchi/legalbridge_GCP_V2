import assert from "node:assert/strict";
import test from "node:test";
import { itemFields, intlItemFields, conditionFields, type FieldDefinition } from "./document-line-fields.js";
import { isFieldVisible } from "./field-visibility.js";

// 明細1行に実際に出る列名（ArrayEditor と同じ絞り込み）。
function visibleNames(fields: FieldDefinition[], row: Record<string, unknown>): string[] {
  return fields.filter((field) => isFieldVisible(field, row)).map((field) => field.name);
}

test("支払方法は固定額・業績連動・定期支払の3つから選べる", () => {
  const calcMethod = itemFields.find((field) => field.name === "calc_method");
  assert.ok(calcMethod, "明細に支払方法の列がある");
  assert.deepEqual(calcMethod.options?.map((option) => option.value),
    ["FIXED", "ROYALTY", "SUBSCRIPTION"]);
  // 発注書テンプレートは calc_method 未設定を固定額として描画する。
  assert.equal(calcMethod.showWhen, undefined);
});

test("未選択でも納期・支払日は入力できる（固定額として出力されるため）", () => {
  const names = visibleNames(itemFields, {});
  assert.ok(names.includes("delivery_date"));
  assert.ok(names.includes("payment_date"));
  assert.ok(!names.includes("rate_pct"));
  assert.ok(!names.includes("term_start"));
});

test("固定額では業績連動・定期支払の列を出さない", () => {
  const names = visibleNames(itemFields, { calc_method: "FIXED" });
  assert.deepEqual(names, [
    "item_name", "spec", "quantity", "unit_price", "amount_ex_tax", "payment_terms",
    "deliverable_ownership", "calc_method", "delivery_date", "payment_date"
  ]);
});

test("業績連動では料率・基準価格・確定報酬名を出す", () => {
  const names = visibleNames(itemFields, { calc_method: "ROYALTY" });
  for (const expected of ["reward_label", "calc_type", "rate_pct", "base_price_label",
    "formula_text", "guarantee_type"]) {
    assert.ok(names.includes(expected), `${expected} が出る`);
  }
  // 納期・支払日は業績連動でもテンプレートが使う。
  assert.ok(names.includes("delivery_date"));
  assert.ok(!names.includes("cycle"));
});

test("最低保証はMG/AGを選んだ側の金額欄だけ出す", () => {
  const none = visibleNames(itemFields, { calc_method: "ROYALTY", guarantee_type: "NONE" });
  assert.ok(!none.includes("mg_amount"));
  assert.ok(!none.includes("ag_amount"));
  const mg = visibleNames(itemFields, { calc_method: "ROYALTY", guarantee_type: "MG" });
  assert.ok(mg.includes("mg_amount"));
  assert.ok(!mg.includes("ag_amount"));
  const ag = visibleNames(itemFields, { calc_method: "ROYALTY", guarantee_type: "AG" });
  assert.ok(ag.includes("ag_amount"));
  assert.ok(!ag.includes("mg_amount"));
});

test("固定額の明細では最低保証の金額欄が出ない（計算方式との AND 判定）", () => {
  const names = visibleNames(itemFields, { calc_method: "FIXED", guarantee_type: "MG" });
  assert.ok(!names.includes("mg_amount"));
});

test("定期支払では期間・支払日サイクルを出し、納期は出さない", () => {
  const names = visibleNames(itemFields, { calc_method: "SUBSCRIPTION" });
  for (const expected of ["cycle", "term_start", "term_end", "billing_day", "billing_timing"]) {
    assert.ok(names.includes(expected), `${expected} が出る`);
  }
  assert.ok(!names.includes("delivery_date"), "納期ではなく役務提供期間を使う");
  assert.ok(!names.includes("payment_date"), "支払日は billing_day から組み立てる");
  assert.ok(!names.includes("rate_pct"));
});

test("出し分けは行ごとに独立している", () => {
  const royalty = visibleNames(itemFields, { calc_method: "ROYALTY" });
  const subscription = visibleNames(itemFields, { calc_method: "SUBSCRIPTION" });
  assert.notDeepEqual(royalty, subscription);
});

test("明細の列名は発注書テンプレートが読む名前と一致する", () => {
  // 名前が変わるとテンプレートの分岐に入らないまま画面だけ増える。
  const names = new Set(itemFields.map((field) => field.name));
  for (const used of ["item_name", "spec", "quantity", "unit_price", "amount_ex_tax",
    "calc_method", "deliverable_ownership", "reward_label", "payment_terms",
    "delivery_date", "payment_date", "term_start", "term_end", "billing_day", "cycle",
    "billing_timing", "rate_pct", "base_price_label", "calc_type", "guarantee_type",
    "mg_amount", "ag_amount", "formula_text"]) {
    assert.ok(names.has(used), `テンプレートが読む ${used} が明細にある`);
  }
});

test("金銭条件表はテンプレートが読む calc_type / guarantee_type を持つ", () => {
  const names = new Set(conditionFields.map((field) => field.name));
  // calc_method は見出しの出し分け用、calc_type は計算式列用で別物。両方必要。
  for (const used of ["condition_name", "region_language_label", "calc_method", "calc_type",
    "fixed_kind", "subscription_cycle", "rate_pct", "base_price_label", "guarantee_type",
    "mg_amount", "ag_amount", "formula_text", "applies_scope"]) {
    assert.ok(names.has(used), `テンプレートが読む ${used} が金銭条件にある`);
  }
});

test("金銭条件でも最低保証の金額欄は選んだ側だけ出す", () => {
  assert.ok(visibleNames(conditionFields, { guarantee_type: "MG" }).includes("mg_amount"));
  assert.ok(!visibleNames(conditionFields, { guarantee_type: "MG" }).includes("ag_amount"));
});

// 海外発注書のサブスク支払日の任意設定（billing_note・英文自由記述）。

test("intlItemFields: billing_note が billing_timing の直後にサブスク限定で入る", () => {
  const names = intlItemFields.map((field) => field.name);
  const timingIndex = names.indexOf("billing_timing");
  assert.equal(names[timingIndex + 1], "billing_note");
  // 国内の itemFields には入れない（国内テンプレートはこの列を読まない）
  assert.equal(itemFields.some((field) => field.name === "billing_note"), false);
  const note = intlItemFields.find((field) => field.name === "billing_note")!;
  assert.deepEqual(note.showWhen, { field: "calc_method", anyOf: ["SUBSCRIPTION"] });
});
