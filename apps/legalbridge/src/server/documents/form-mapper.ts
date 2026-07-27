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

export function validateDocumentForm(
  fields: TemplateField[],
  data: DocumentFormData
): Array<{ field: string; message: string }> {
  return fields.flatMap((field) => {
    if (!field.required) return [];
    const value = data[field.name];
    const empty = value === undefined || value === null || value === "";
    return empty ? [{ field: field.name, message: `${field.label ?? field.name}は必須です` }] : [];
  });
}
