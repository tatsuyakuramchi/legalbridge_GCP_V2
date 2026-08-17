import type { DocumentFormData, ShowWhenCondition } from "../types";

// showWhen を持つものなら何でも判定できる（テンプレート項目でも、明細1行の列でも）。
type ConditionallyVisible = { showWhen?: ShowWhenCondition | ShowWhenCondition[] };

// truthy 判定の「値がある」。空配列は JS では真だが、明細0件を「明細あり」と
// 判定してしまうため件数で見る（発注書の単一明細フォールバックの出し分けに必要）。
function hasValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

// showWhen（field_schema の条件表示）の判定。純関数。
// - anyOf: 参照先の値（文字列化）がいずれかに一致すれば表示
// - truthy: 参照先に値があるか／無いかと一致すれば表示
// - 配列: すべての条件を満たしたときだけ表示（AND）
// - 条件なし・不正な条件は常に表示（テンプレートの書き損じで項目が消えないように）
function matches(condition: ShowWhenCondition, formData: DocumentFormData): boolean {
  if (!condition?.field) return true;
  const value = formData[condition.field];
  if (Array.isArray(condition.anyOf)) {
    return condition.anyOf.includes(String(value ?? ""));
  }
  if (typeof condition.truthy === "boolean") {
    return hasValue(value) === condition.truthy;
  }
  return true;
}

export function isFieldVisible(field: ConditionallyVisible, formData: DocumentFormData): boolean {
  const condition = field.showWhen;
  if (!condition) return true;
  if (Array.isArray(condition)) return condition.every((c) => matches(c, formData));
  return matches(condition, formData);
}
