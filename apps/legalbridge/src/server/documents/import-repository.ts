import { z } from "zod";
import type { DatabasePool } from "../db/pool.js";

// Register a legacy/past document as a record in the documents table without
// going through generation. Reuses the already-granted documents INSERT; no
// schema/template change. template_version_id is nullable, so historical rows
// are stored with NULL version and empty form_data.
const trimmed = z.string().trim();
export const documentImportRowSchema = z.object({
  documentNumber: trimmed.min(1, "文書番号は必須です").max(100),
  templateType: trimmed.min(1, "テンプレート種別は必須です").max(100),
  issueKey: z.string().trim().max(100).optional().transform((v) => v ?? ""),
  driveLink: z.string().trim().max(1000).optional().transform((v) => v ?? ""),
  matterId: z.coerce.number().int().positive().optional().nullable().transform((v) => v ?? null)
});
export type DocumentImportRow = z.infer<typeof documentImportRowSchema>;

export interface ImportedDocument { id: number; documentNumber: string; }

export class DocumentImportError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export interface DocumentImportRepository {
  importOne(input: DocumentImportRow, createdBy: string): Promise<ImportedDocument>;
}

export class PgDocumentImportRepository implements DocumentImportRepository {
  constructor(private readonly database: DatabasePool) {}
  async importOne(input: DocumentImportRow, createdBy: string) {
    try {
      const columns = ["document_number", "issue_key", "template_type", "form_data", "drive_link", "created_at", "created_by"];
      const values: unknown[] = [input.documentNumber, input.issueKey, input.templateType, "{}", input.driveLink, createdBy];
      // $6 is created_by; created_at is now(); append matter_id when provided.
      let valueSql = "$1, $2, $3, $4::jsonb, $5, now(), $6";
      if (input.matterId !== null) {
        columns.push("matter_id");
        values.push(input.matterId);
        valueSql += ", $7";
      }
      const result = await this.database.query(
        `INSERT INTO documents (${columns.join(", ")}) VALUES (${valueSql})
         RETURNING id, document_number`,
        values
      );
      return { id: Number(result.rows[0].id), documentNumber: String(result.rows[0].document_number) };
    } catch (error) { throw translate(error); }
  }
}

function translate(error: unknown): Error {
  if (error instanceof DocumentImportError) return error;
  const code = (error as { code?: string })?.code;
  if (code === "23505") return new DocumentImportError("DOCUMENT_CONFLICT", "その文書番号は既に存在します");
  if (code === "23503") return new DocumentImportError("DOCUMENT_REFERENCE_INVALID", "案件などの参照先が存在しません");
  if (code === "23502") return new DocumentImportError("DOCUMENT_REQUIRED", "必須項目が不足しています");
  return error instanceof Error ? error : new Error(String(error));
}

export class MemoryDocumentImportRepository implements DocumentImportRepository {
  private seq = 0;
  readonly documents: ImportedDocument[] = [];
  async importOne(input: DocumentImportRow) {
    if (this.documents.some((d) => d.documentNumber === input.documentNumber)) {
      throw new DocumentImportError("DOCUMENT_CONFLICT", "その文書番号は既に存在します");
    }
    const doc = { id: ++this.seq, documentNumber: input.documentNumber };
    this.documents.push(doc);
    return doc;
  }
}
