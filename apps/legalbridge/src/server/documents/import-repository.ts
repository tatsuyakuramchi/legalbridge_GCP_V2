import { z } from "zod";
import type { DatabasePool } from "../db/pool.js";

// Register a legacy/past document as a record in the documents table without
// going through generation. Reuses the already-granted documents INSERT; no
// schema/template change. template_version_id is nullable, so historical rows
// are stored with NULL version and empty form_data.
//
// 取込強化（2026-08-21）: 件名・相手先・日付・元ファイル名・MIME を form_data の
// 既存キー（title / counterparty / document_date / original_file_name /
// source_mime_type）に格納する。一覧の件名・相手先はこのキーから解決され、
// メールPDF添付・CloudSign送信のPDF判定（looksLikePdf）もこのキーを見るため、
// これを記録して初めて「取り込んだ過去文書をそのまま送れる」状態になる。
const trimmed = z.string().trim();
const optionalText = (max: number) =>
  z.string().trim().max(max).optional().transform((v) => v ?? "");
export const documentImportRowSchema = z.object({
  documentNumber: trimmed.min(1, "文書番号は必須です").max(100),
  templateType: trimmed.min(1, "テンプレート種別は必須です").max(100),
  issueKey: optionalText(100),
  driveLink: optionalText(1000),
  matterId: z.coerce.number().int().positive().optional().nullable().transform((v) => v ?? null),
  title: optionalText(300),
  counterparty: optionalText(300),
  documentDate: optionalText(20).transform((v, ctx) => {
    const normalized = normalizeDate(v);
    if (normalized === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "日付は YYYY-MM-DD 形式で入力してください" });
      return z.NEVER;
    }
    return normalized;
  }),
  originalFileName: optionalText(300),
  mimeType: optionalText(150)
});
export type DocumentImportRow = z.infer<typeof documentImportRowSchema>;

// 2024/3/5 → 2024-03-05 に正規化。空は空のまま、それ以外の形式は null（＝エラー）。
export function normalizeDate(value: string): string | null {
  if (!value) return "";
  const match = value.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!match) return null;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${match[1]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// 拡張子からの MIME 推定。PDF判定（looksLikePdf）はファイル名の .pdf でも通るが、
// 記録しておくと CloudSign 拒否時の理由表示などで種別が見える。
const EXTENSION_MIME: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  txt: "text/plain", csv: "text/csv", zip: "application/zip"
};
export function inferMimeType(fileName: string): string {
  const match = fileName.trim().toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? EXTENSION_MIME[match[1]] ?? "" : "";
}

// 取込行から form_data に格納する内容を組み立てる（空値は入れない）。
export function buildImportFormData(input: DocumentImportRow): Record<string, string> {
  const formData: Record<string, string> = {};
  if (input.title) formData.title = input.title;
  if (input.counterparty) formData.counterparty = input.counterparty;
  if (input.documentDate) formData.document_date = input.documentDate;
  if (input.originalFileName) formData.original_file_name = input.originalFileName;
  const mime = input.mimeType || inferMimeType(input.originalFileName);
  if (mime) formData.source_mime_type = mime;
  return formData;
}

export interface ImportedDocument { id: number; documentNumber: string; }

export class DocumentImportError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export interface DocumentImportRepository {
  importOne(input: DocumentImportRow, createdBy: string): Promise<ImportedDocument>;
  // アップロード取込の事前重複チェック（Drive へ上げる前に番号衝突を弾く）。
  exists(documentNumber: string): Promise<boolean>;
}

export class PgDocumentImportRepository implements DocumentImportRepository {
  constructor(private readonly database: DatabasePool) {}
  async importOne(input: DocumentImportRow, createdBy: string) {
    try {
      const columns = ["document_number", "issue_key", "template_type", "form_data", "drive_link", "created_at", "created_by"];
      const values: unknown[] = [
        input.documentNumber, input.issueKey, input.templateType,
        JSON.stringify(buildImportFormData(input)), input.driveLink, createdBy
      ];
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

  async exists(documentNumber: string) {
    const result = await this.database.query(
      `SELECT 1 FROM documents WHERE document_number = $1 LIMIT 1`,
      [documentNumber]
    );
    return result.rows.length > 0;
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
  // テスト検証用: 取込行と form_data 化した内容も記録する。
  readonly inputs: Array<{ row: DocumentImportRow; formData: Record<string, string> }> = [];
  async importOne(input: DocumentImportRow) {
    if (this.documents.some((d) => d.documentNumber === input.documentNumber)) {
      throw new DocumentImportError("DOCUMENT_CONFLICT", "その文書番号は既に存在します");
    }
    const doc = { id: ++this.seq, documentNumber: input.documentNumber };
    this.documents.push(doc);
    this.inputs.push({ row: input, formData: buildImportFormData(input) });
    return doc;
  }
  async exists(documentNumber: string) {
    return this.documents.some((d) => d.documentNumber === documentNumber);
  }
}
