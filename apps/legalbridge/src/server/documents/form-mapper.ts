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
  matter?: Record<string, unknown>;
  document?: Record<string, unknown>;
  work?: Record<string, unknown>;
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

  applyAliases(schema, data, sources.backlog, {
    PROJECT_TITLE: "summary", REQUEST_SUMMARY: "summary", CONTRACT_TITLE: "summary",
    DETAILS: "details", REQUEST_DETAILS: "details", DEADLINE: "deadline", DUE_DATE: "deadline",
    counterparty: "counterparty"
  });
  applyAliases(schema, data, sources.matter, {
    MATTER_CODE: "matter_code", MATTER_TITLE: "title", PROJECT_TITLE: "title",
    DUE_DATE: "target_due_date", DEADLINE: "target_due_date", counterparty: "counterparty"
  });
  applyAliases(schema, data, sources.vendor, {
    VENDOR_NAME: "vendor_name", VENDOR_ADDRESS: "address", VENDOR_REP: "vendor_rep",
    VENDOR_EMAIL: "email", VENDOR_CONTACT_NAME: "contact_name",
    VENDOR_CONTACT_DEPARTMENT: "contact_department", VENDOR_CONTACT_PHONE: "phone",
    BANK_NAME: "bank_name", BRANCH_NAME: "branch_name", ACCOUNT_TYPE: "account_type",
    ACCOUNT_NUMBER: "account_number", ACCOUNT_HOLDER_KANA: "account_holder_kana",
    INVOICE_REGISTRATION_NUMBER: "invoice_registration_number",
    Licensor_名称: "vendor_name", Licensor_氏名会社名: "vendor_name",
    Licensor_住所: "address", Licensor_代表者名: "vendor_rep",
    Licensor_担当者: "contact_name", Licensor_電話: "phone", Licensor_メール: "email",
    counterparty: "vendor_name", 許諾者: "vendor_name", 許諾者住所: "address",
    許諾者氏名: "vendor_name", 許諾者法人名: "vendor_name", 代表者氏名: "vendor_rep",
    担当者氏名: "contact_name", 担当者電話番号: "phone", 担当者メール: "email",
    振込先銀行名: "bank_name", 支店名: "branch_name", 口座種別: "account_type",
    口座番号: "account_number", 口座名義カナ: "account_holder_kana",
    インボイス登録番号: "invoice_registration_number"
  });
  applyAliases(schema, data, sources.staff, {
    STAFF_NAME: "staff_name", STAFF_DEPARTMENT: "department", STAFF_EMAIL: "email",
    STAFF_PHONE: "phone", 監修者: "staff_name", inspectorName: "staff_name",
    inspectorDept: "department"
  });
  applyAliases(schema, data, sources.company, {
    COMPANY_NAME: "name", COMPANY_ADDRESS: "address", COMPANY_REP: "rep",
    COMPANY_REPRESENTATIVE: "rep", PARTY_A_NAME: "name", PARTY_A_ADDRESS: "address",
    PARTY_A_REP: "rep", Licensee_名称: "name", Licensee_氏名会社名: "name",
    Licensee_住所: "address", Licensee_代表者名: "rep", licensee: "name",
    アークライト住所: "address", アークライト代表者氏名: "rep"
  });
  applyAliases(schema, data, sources.document, {
    MASTER_CONTRACT_REF: "document_number", 基本契約名: "document_number",
    基本契約番号: "document_number", linked_contract_number: "document_number",
    parent_po_number: "document_number", ORDER_NO: "document_number"
  });
  applyAliases(schema, data, sources.work, {
    work_id: "code", WORK_ID: "code", 台帳ID: "code", 原著作物名: "title",
    対象作品予定名: "title", 対象製品予定名: "title"
  });

  // 下書きを最後に適用する。field_schemaにない互換キーも削除しない。
  return { ...data, ...draft };
}

function applyAliases(
  schema: DocumentFormSchema,
  data: DocumentFormData,
  source: Record<string, unknown> | undefined,
  aliases: Record<string, string>
) {
  if (!source) return;
  const fields = new Set(schema.fields.map((field) => field.name));
  for (const [fieldName, sourceKey] of Object.entries(aliases)) {
    if (!fields.has(fieldName) || data[fieldName] !== undefined && data[fieldName] !== "") continue;
    const value = source[sourceKey];
    if (value !== undefined && value !== null && value !== "") data[fieldName] = value;
  }
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
