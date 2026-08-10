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
  baseDocumentNumber?: string | null;   // バージョン系列の基底番号（アーカイブ履歴・10-1）
  supersededBy?: string | null;         // これを差し替えた文書番号
  isPrimary?: boolean;                  // 系列内の正本フラグ
  formData: Record<string, unknown>;
}

// アーカイブのバージョン履歴 1 件（同一 base_document_number の系列・10-1）。
export interface DocumentVersion {
  id: number;
  documentNumber: string | null;
  templateType: string;
  lifecycleStatus: string;
  isPrimary: boolean;
  supersededBy: string | null;
  createdAt: string;
}

// 一覧の状態フィルタ（アーカイブ・10-1）。all=全件 / active=void以外 / voided=void のみ。
export type LifecycleFilter = "all" | "active" | "voided";

export interface DocumentRegistryRepository {
  list(query: string, templateType?: string, limit?: number, lifecycle?: LifecycleFilter): Promise<RegisteredDocument[]>;
  find(id: number): Promise<RegisteredDocument | null>;
  findByNumber(documentNumber: string): Promise<RegisteredDocument | null>;
  // バージョン履歴（同一系列を古い順）。文書が無ければ空配列。
  versionHistory(id: number): Promise<DocumentVersion[]>;
  setDriveLink(id: number, driveLink: string): Promise<void>;
}

export class PgDocumentRegistryRepository implements DocumentRegistryRepository {
  constructor(private readonly database: DatabasePool) {}

  async list(query: string, templateType?: string, limit = 100, lifecycle: LifecycleFilter = "all") {
    const keyword = `%${query.trim()}%`;
    const lifecycleClause =
      lifecycle === "active" ? "AND COALESCE(lifecycle_status, 'final') <> 'voided'"
      : lifecycle === "voided" ? "AND COALESCE(lifecycle_status, 'final') = 'voided'"
      : "";
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
          ${lifecycleClause}
        ORDER BY created_at DESC NULLS LAST, id DESC
        LIMIT $3`,
      [keyword, templateType ?? "", Math.min(Math.max(limit, 1), 200)]
    );
    return result.rows.map(mapRow);
  }

  async versionHistory(id: number): Promise<DocumentVersion[]> {
    const result = await this.database.query(
      `WITH target AS (
         SELECT COALESCE(NULLIF(base_document_number, ''), document_number) AS base
           FROM documents WHERE id = $1
       )
       SELECT id, document_number, template_type,
              COALESCE(lifecycle_status, 'final') AS lifecycle_status,
              COALESCE(is_primary, true) AS is_primary,
              superseded_by, created_at
         FROM documents
        WHERE (SELECT base FROM target) IS NOT NULL
          AND COALESCE(NULLIF(base_document_number, ''), document_number) = (SELECT base FROM target)
        ORDER BY created_at ASC NULLS FIRST, id ASC`,
      [id]
    );
    return result.rows.map(mapVersion);
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

  async findByNumber(documentNumber: string) {
    const result = await this.database.query(
      `SELECT id, document_number, issue_key, template_type, template_version_id,
              form_data, drive_link, created_at, created_by,
              COALESCE(lifecycle_status, 'final') AS lifecycle_status
         FROM documents
        WHERE document_number = $1
        ORDER BY id DESC
        LIMIT 1`,
      [documentNumber]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }
}

export class MemoryDocumentRegistryRepository implements DocumentRegistryRepository {
  constructor(private readonly documents: RegisteredDocument[] = []) {}

  async list(query: string, templateType?: string, limit = 100, lifecycle: LifecycleFilter = "all") {
    const keyword = query.trim().toLowerCase();
    return this.documents
      .filter((item) => !templateType || item.templateType === templateType)
      .filter((item) => {
        const status = item.lifecycleStatus ?? "final";
        if (lifecycle === "active") return status !== "voided";
        if (lifecycle === "voided") return status === "voided";
        return true;
      })
      .filter((item) => !keyword || [
        item.documentNumber, item.issueKey, item.templateType, item.title, item.counterparty
      ].some((value) => value?.toLowerCase().includes(keyword)))
      .slice(0, limit);
  }

  async versionHistory(id: number): Promise<DocumentVersion[]> {
    const target = this.documents.find((d) => d.id === id);
    if (!target) return [];
    const base = (target.baseDocumentNumber || target.documentNumber) ?? null;
    if (!base) return [];
    return this.documents
      .filter((d) => ((d.baseDocumentNumber || d.documentNumber) ?? null) === base)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id - b.id))
      .map((d) => ({
        id: d.id, documentNumber: d.documentNumber, templateType: d.templateType,
        lifecycleStatus: d.lifecycleStatus ?? "final", isPrimary: d.isPrimary ?? true,
        supersededBy: d.supersededBy ?? null, createdAt: d.createdAt
      }));
  }

  async find(id: number) {
    return this.documents.find((item) => item.id === id) ?? null;
  }

  async findByNumber(documentNumber: string) {
    return this.documents.find((item) => item.documentNumber === documentNumber) ?? null;
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

function mapVersion(row: Record<string, any>): DocumentVersion {
  return {
    id: Number(row.id),
    documentNumber: row.document_number ?? null,
    templateType: row.template_type,
    lifecycleStatus: row.lifecycle_status ?? "final",
    isPrimary: row.is_primary !== false,
    supersededBy: row.superseded_by ?? null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : ""
  };
}

function firstText(values: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = values[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}
