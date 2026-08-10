import type { DatabasePool } from "../db/pool.js";

export interface RegisteredDocument {
  id: number;
  documentNumber: string | null;
  issueKey: string;
  templateType: string;
  templateVersionId: number | null;
  title: string;
  counterparty: string;
  driveLink: string;
  createdAt: string;
  createdBy: string | null;
  lifecycleStatus?: string;   // final / voided / draft 等（void 済みの表示に使用・Phase 10-2）
  formData: Record<string, unknown>;
}

export interface DocumentRegistryRepository {
  list(query: string, templateType?: string, limit?: number): Promise<RegisteredDocument[]>;
  find(id: number): Promise<RegisteredDocument | null>;
  setDriveLink(id: number, driveLink: string): Promise<void>;
}

export class PgDocumentRegistryRepository implements DocumentRegistryRepository {
  constructor(private readonly database: DatabasePool) {}

  async list(query: string, templateType?: string, limit = 100) {
    const keyword = `%${query.trim()}%`;
    const result = await this.database.query(
      `SELECT id, document_number, issue_key, template_type, template_version_id,
              form_data, drive_link, created_at, created_by,
              COALESCE(lifecycle_status, 'final') AS lifecycle_status
         FROM documents
        WHERE ($1 = '%%'
          OR COALESCE(document_number, '') ILIKE $1
          OR issue_key ILIKE $1
          OR template_type ILIKE $1
          OR COALESCE(form_data->>'PROJECT_TITLE', form_data->>'CONTRACT_TITLE',
                      form_data->>'基本契約名', form_data->>'VENDOR_NAME',
                      form_data->>'Licensor_氏名会社名', '') ILIKE $1)
          AND ($2 = '' OR template_type = $2)
        ORDER BY created_at DESC NULLS LAST, id DESC
        LIMIT $3`,
      [keyword, templateType ?? "", Math.min(Math.max(limit, 1), 200)]
    );
    return result.rows.map(mapRow);
  }

  async setDriveLink(id: number, driveLink: string) {
    const result = await this.database.query(
      `UPDATE documents SET drive_link = $2 WHERE id = $1`,
      [id, driveLink]
    );
    if (result.rowCount !== 1) throw new Error("document not found while updating drive link");
  }

  async find(id: number) {
    const result = await this.database.query(
      `SELECT id, document_number, issue_key, template_type, template_version_id,
              form_data, drive_link, created_at, created_by,
              COALESCE(lifecycle_status, 'final') AS lifecycle_status
         FROM documents
        WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }
}

export class MemoryDocumentRegistryRepository implements DocumentRegistryRepository {
  constructor(private readonly documents: RegisteredDocument[] = []) {}

  async list(query: string, templateType?: string, limit = 100) {
    const keyword = query.trim().toLowerCase();
    return this.documents
      .filter((item) => !templateType || item.templateType === templateType)
      .filter((item) => !keyword || [
        item.documentNumber, item.issueKey, item.templateType, item.title, item.counterparty
      ].some((value) => value?.toLowerCase().includes(keyword)))
      .slice(0, limit);
  }

  async find(id: number) {
    return this.documents.find((item) => item.id === id) ?? null;
  }

  async setDriveLink(id: number, driveLink: string) {
    const document = this.documents.find((item) => item.id === id);
    if (!document) throw new Error("document not found while updating drive link");
    document.driveLink = driveLink;
  }
}

function mapRow(row: Record<string, any>): RegisteredDocument {
  const formData = row.form_data ?? {};
  return {
    id: Number(row.id),
    documentNumber: row.document_number,
    issueKey: row.issue_key,
    templateType: row.template_type,
    templateVersionId: row.template_version_id,
    title: firstText(formData, [
      "PROJECT_TITLE", "CONTRACT_TITLE", "基本契約名", "件名", "title"
    ]) || row.document_number || row.issue_key,
    counterparty: firstText(formData, [
      "VENDOR_NAME", "Licensor_氏名会社名", "Licensor_名称",
      "許諾者", "相手先", "counterparty"
    ]),
    driveLink: row.drive_link ?? "",
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : "",
    createdBy: row.created_by,
    lifecycleStatus: row.lifecycle_status ?? "final",
    formData
  };
}

function firstText(values: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = values[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}
