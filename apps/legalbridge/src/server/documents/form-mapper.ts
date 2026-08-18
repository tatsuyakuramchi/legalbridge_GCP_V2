import {
  isFieldVisible, isInspectionFallbackFieldHidden, isRoyaltyComputedFieldHidden
} from "../../field-visibility.js";
import type {
  DocumentFormData,
  DocumentFormSchema,
  TemplateField
} from "../../types.js";

export interface FormContextSources {
  auto?: Record<string, unknown>;
  backlog?: Record<string, unknown>;
  company?: Record<string, unknown>;
  staff?: Record<string, unknown>;
  vendor?: Record<string, unknown>;
}

function readPath(source: FormContextSources, path?: string): unknown {
  if (!path) return undefined;
  const [namespace, key] = path.split(".", 2);
  if (!namespace || !key) return undefined;
  return source[namespace as keyof FormContextSources]?.[key];
}

export function buildDocumentFormContext(
  schema: DocumentFormSchema,
  sources: FormContextSources,
  draft: DocumentFormData = {}
): DocumentFormData {
  const data: DocumentFormData = {};

  for (const field of schema.fields) {
    const initialValue = readPath(sources, field.dbField);
    if (initialValue !== undefined) data[field.name] = initialValue;
  }

  // 下書きを最後に適用する。field_schemaにない互換キーも削除しない。
  return { ...data, ...draft };
}

// 必須チェックは「画面に出ている項目」だけに掛ける。クライアントと同じ可視性ルール
// （showWhen・検収書の単票フォールバック・計算書の自動計算欄）で判定しないと、
// 明細モードで隠れた必須項目（納品額など）が空のまま検証に落ち、プレビュー・確定が
// 「入力しようのない項目が必須です」で塞がる（検収書プレビュー不出の原因）。
export function validateDocumentForm(
  templateKey: string,
  fields: TemplateField[],
  data: DocumentFormData
): Array<{ field: string; message: string }> {
  return fields.flatMap((field) => {
    if (!field.required) return [];
    if (!isFieldVisible(field, data)) return [];
    if (isInspectionFallbackFieldHidden(templateKey, field.name, data)) return [];
    if (isRoyaltyComputedFieldHidden(templateKey, field.name, data)) return [];
    const value = data[field.name];
    const empty = value === undefined || value === null || value === "";
    return empty ? [{ field: field.name, message: `${field.label ?? field.name}は必須です` }] : [];
  });
}
