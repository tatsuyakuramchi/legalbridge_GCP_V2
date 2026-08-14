import type { DocumentFormData, TemplateField } from "../types";

// showWhen（field_schema の条件表示）の判定。純関数。
// - anyOf: 参照先の値（文字列化）がいずれかに一致すれば表示
// - truthy: 参照先のチェック有無と一致すれば表示
// - 条件なし・不正な条件は常に表示（テンプレートの書き損じで項目が消えないように）
export function isFieldVisible(field: TemplateField, formData: DocumentFormData): boolean {
  const condition = field.showWhen;
  if (!condition || !condition.field) return true;
  const value = formData[condition.field];
  if (Array.isArray(condition.anyOf)) {
    return condition.anyOf.includes(String(value ?? ""));
  }
  if (typeof condition.truthy === "boolean") {
    return Boolean(value) === condition.truthy;
  }
  return true;
}
