import type { DatabasePool } from "../db/pool.js";
import type { DocumentDraft, DocumentDraftSummary, DocumentFormData } from "../../types.js";

export interface SaveDraftInput {
  issueKey: string;
  templateType: string;
  formData: DocumentFormData;
  documentNumber?: string | null;
  updatedBy?: string | null;
  expectedUpdatedAt?: string | null;
}

export interface DraftRepository {
  list(query?: string, limit?: number): Promise<DocumentDraftSummary[]>;
  find(issueKey: string, templateType: string): Promise<DocumentDraft | null>;
  save(input: SaveDraftInput): Promise<DocumentDraft>;
  remove(issueKey: string, templateType: string): Promise<boolean>;
}

export class PgDraftRepository implements DraftRepository {
  constructor(private readonly database: DatabasePool) {}

  async list(query = "", limit = 50) {
    const normalizedQuery = query.trim();
    const values: unknown[] = [];
    const where = normalizedQuery
      ? `WHERE issue_key ILIKE $1
          OR template_type ILIKE $1
          OR COALESCE(document_number, '') ILIKE $1
          OR COALESCE(updated_by, '') ILIKE $1`
      : "";
    if (normalizedQuery) values.push(`%${normalizedQuery}%`);
    values.push(Math.min(Math.max(limit, 1), 100));
    const limitParameter = values.length;
    const result = await this.database.query<DraftRow>(
      `${SELECT_DRAFT}
       ${where}
       ORDER BY updated_at DESC, id DESC
       LIMIT ${limitParameter}`,
      values
    );
    return result.rows.map(mapDraftSummary);
  }

  async find(issueKey: string, templateType: string) {
    const result = await this.database.query<DraftRow>(
      `${SELECT_DRAFT}
       WHERE issue_key = $1 AND template_type = $2
       LIMIT 1`,
      [issueKey, templateType]
    );
    return result.rows[0] ? mapDraft(result.rows[0]) : null;
  }

  async save(input: SaveDraftInput) {
    if (input.expectedUpdatedAt) {
      const current = await this.find(input.issueKey, input.templateType);
      if (current && current.updatedAt !== input.expectedUpdatedAt) {
        throw new DraftConflictError(current);
      }
    }

    const result = await this.database.query<DraftRow>(
      `INSERT INTO document_drafts (
         issue_key, template_type, form_data, document_number, updated_by, updated_at
       ) VALUES ($1, $2, $3::jsonb, $4, $5, now())
       ON CONFLICT (issue_key, template_type) DO UPDATE SET
         form_data = EXCLUDED.form_data,
         document_number = COALESCE(document_drafts.document_number, EXCLUDED.document_number),
         updated_by = EXCLUDED.updated_by,
         updated_at = now()
       RETURNING id, issue_key, template_type, form_data, document_number, updated_at, updated_by`,
      [
        input.issueKey,
        input.templateType,
        JSON.stringify(input.formData),
        input.documentNumber ?? null,
        input.updatedBy ?? null
      ]
    );
    return mapDraft(result.rows[0]);
  }

  async remove(issueKey: string, templateType: string) {
    const result = await this.database.query(
      `DELETE FROM document_drafts
       WHERE issue_key = $1 AND template_type = $2`,
      [issueKey, templateType]
    );
    return (result.rowCount ?? 0) > 0;
  }
}

export class DraftConflictError extends Error {
  constructor(readonly current: DocumentDraft) {
    super("draft has been updated by another session");
  }
}

interface DraftRow {
  id: number;
  issue_key: string;
  template_type: string;
  form_data: DocumentFormData;
  document_number: string | null;
  updated_at: Date | string;
  updated_by: string | null;
}

const SELECT_DRAFT = `
  SELECT id, issue_key, template_type, form_data, document_number, updated_at, updated_by
  FROM document_drafts
`;

function mapDraftSummary(row: DraftRow): DocumentDraftSummary {
  return {
    id: row.id,
    issueKey: row.issue_key,
    templateType: row.template_type,
    documentNumber: row.document_number,
    updatedAt: new Date(row.updated_at).toISOString(),
    updatedBy: row.updated_by
  };
}

function mapDraft(row: DraftRow): DocumentDraft {
  return {
    id: row.id,
    issueKey: row.issue_key,
    templateType: row.template_type,
    formData: row.form_data ?? {},
    documentNumber: row.document_number,
    updatedAt: new Date(row.updated_at).toISOString(),
    updatedBy: row.updated_by
  };
}

export class MemoryDraftRepository implements DraftRepository {
  private readonly drafts = new Map<string, DocumentDraft>();
  private sequence = 1;

  async list(query = "", limit = 50) {
    const normalizedQuery = query.trim().toLowerCase();
    return [...this.drafts.values()]
      .filter((draft) => !normalizedQuery || [
        draft.issueKey,
        draft.templateType,
        draft.documentNumber ?? "",
        draft.updatedBy ?? ""
      ].some((value) => value.toLowerCase().includes(normalizedQuery)))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, Math.min(Math.max(limit, 1), 100))
      .map(({ formData: _formData, ...summary }) => summary);
  }

  async find(issueKey: string, templateType: string) {
    return this.drafts.get(`${issueKey}:${templateType}`) ?? null;
  }

  async save(input: SaveDraftInput) {
    const key = `${input.issueKey}:${input.templateType}`;
    const current = this.drafts.get(key);
    if (input.expectedUpdatedAt && current?.updatedAt !== input.expectedUpdatedAt) {
      throw new DraftConflictError(current!);
    }
    const value: DocumentDraft = {
      id: current?.id ?? this.sequence++,
      issueKey: input.issueKey,
      templateType: input.templateType,
      formData: input.formData,
      documentNumber: current?.documentNumber ?? input.documentNumber ?? null,
      updatedAt: new Date().toISOString(),
      updatedBy: input.updatedBy ?? null
    };
    this.drafts.set(key, value);
    return value;
  }

  async remove(issueKey: string, templateType: string) {
    return this.drafts.delete(`${issueKey}:${templateType}`);
  }
}

