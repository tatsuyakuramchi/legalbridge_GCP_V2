import type { DocumentFormData, ShowWhenCondition } from "../types";

// showWhen を持つものなら何でも判定できる（テンプレート項目でも、明細1行の列でも）。
type ConditionallyVisible = { showWhen?: ShowWhenCondition | ShowWhenCondition[] };

// showWhen（field_schema の条件表示）の判定。純関数。
// - anyOf: 参照先の値（文字列化）がいずれかに一致すれば表示
// - truthy: 参照先のチェック有無と一致すれば表示
// - 配列: すべての条件を満たしたときだけ表示（AND）
// - 条件なし・不正な条件は常に表示（テンプレートの書き損じで項目が消えないように）
function matches(condition: ShowWhenCondition, formData: DocumentFormData): boolean {
  if (!condition?.field) return true;
  const value = formData[condition.field];
  if (Array.isArray(condition.anyOf)) {
    return condition.anyOf.includes(String(value ?? ""));
  }
  if (typeof condition.truthy === "boolean") {
    return Boolean(value) === condition.truthy;
  }
  return true;
}

export function isFieldVisible(field: ConditionallyVisible, formData: DocumentFormData): boolean {
  const condition = field.showWhen;
  if (!condition) return true;
  if (Array.isArray(condition)) return condition.every((c) => matches(c, formData));
  return matches(condition, formData);
}
