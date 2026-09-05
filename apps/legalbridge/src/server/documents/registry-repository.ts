import type { DatabasePool } from "../db/pool.js";

export interface RegisteredDocument {
  id: number;
  documentNumber: string | null;
  previousDocumentNumber?: string | null;
  issueKey: string;
  templateType: string;
  templateVersionId: number | null;
  title: string;
  counterparty: string;
  driveLink: string;
  createdAt: string;
  createdBy: string | null;
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
      `SELECT d.id, d.document_number, h.previous_document_number, d.issue_key, d.template_type, d.template_version_id,
              d.form_data, d.drive_link, d.created_at, d.created_by
         FROM documents d
         LEFT JOIN LATERAL (
           SELECT previous_document_number
             FROM document_number_history
            WHERE document_id = d.id
            ORDER BY changed_at DESC, id DESC
            LIMIT 1
         ) h ON true
        WHERE ($1 = '%%'
          OR COALESCE(d.document_number, '') ILIKE $1
          OR d.issue_key ILIKE $1
          OR d.template_type ILIKE $1
          OR COALESCE(d.form_data->>'PROJECT_TITLE', d.form_data->>'CONTRACT_TITLE',
                      d.form_data->>'基本契約名', d.form_data->>'VENDOR_NAME',
                      d.form_data->>'Licensor_氏名会社名', '') ILIKE $1
          OR COALESCE(h.previous_document_number, '') ILIKE $1)
          AND ($2 = '' OR d.template_type = $2)
        ORDER BY d.created_at DESC NULLS LAST, d.id DESC
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
      `SELECT d.id, d.document_number, h.previous_document_number, d.issue_key, d.template_type, d.template_version_id,
              d.form_data, d.drive_link, d.created_at, d.created_by
         FROM documents d
         LEFT JOIN LATERAL (
           SELECT previous_document_number
             FROM document_number_history
            WHERE document_id = d.id
            ORDER BY changed_at DESC, id DESC
            LIMIT 1
         ) h ON true
        WHERE d.id = $1`,
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
    previousDocumentNumber: row.previous_document_number ?? legacyPreviousNumber(formData),
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
    formData
  };
}

function legacyPreviousNumber(values: Record<string, unknown>) {
  return firstText(values, [
    "PREVIOUS_DOCUMENT_NUMBER", "旧文書番号", "旧契約書番号",
    "BASE_DOC_NO", "元文書番号", "元契約番号",
    "previousDocumentNumber", "baseDocumentNumber", "originalDocumentNumber"
  ]) || null;
}

function firstText(values: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = values[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}
