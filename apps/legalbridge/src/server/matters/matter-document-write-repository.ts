import type { DatabasePool } from "../db/pool.js";
import { MatterWriteError } from "./write-repository.js";

// 案件⇄文書のリンク付け替え（documents.matter_id）。grant 026 で列レベル UPDATE(matter_id)。
// link=SET matter_id、unlink=SET matter_id=NULL（文書行は削除しない）。
// registerFromDrive=Drive ファイルを外部文書として documents に新規登録（8-2b）。
//   template_type='external_file'・document_number は NULL（採番しない）・
//   INSERT は grant 006（documents SELECT/INSERT）で足りる（新規 grant 不要）。
//   冪等：同一案件×同一 drive_link が既にあれば作らず既存を返す。

export interface LinkedDocument {
  id: number;
  documentNumber: string | null;
  driveLink: string;
}

export interface RegisteredDriveDocument { document: LinkedDocument; created: boolean }

export interface MatterDocumentWriteRepository {
  link(matterId: number, documentId: number): Promise<LinkedDocument>;
  unlink(matterId: number, documentId: number): Promise<boolean>;
  registerFromDrive(matterId: number, input: { link: string; name: string }): Promise<RegisteredDriveDocument>;
}

function translate(error: unknown): never {
  const code = (error as { code?: string })?.code;
  if (code === "42501") {
    throw new MatterWriteError("MATTER_DOCUMENT_GRANT_MISSING", "documents への権限がありません（grant 026 未適用）");
  }
  if (code === "23503") {
    throw new MatterWriteError("MATTER_NOT_FOUND", "案件が存在しません");
  }
  throw error as Error;
}

export class PgMatterDocumentWriteRepository implements MatterDocumentWriteRepository {
  constructor(private readonly database: DatabasePool) {}

  async link(matterId: number, documentId: number) {
    try {
      const result = await this.database.query(
        `UPDATE documents SET matter_id = $1 WHERE id = $2
         RETURNING id, document_number, drive_link`,
        [matterId, documentId]
      );
      if (!result.rows[0]) {
        throw new MatterWriteError("MATTER_DOCUMENT_NOT_FOUND", "文書が見つかりません");
      }
      const row = result.rows[0];
      return { id: Number(row.id), documentNumber: row.document_number, driveLink: row.drive_link ?? "" };
    } catch (error) {
      if (error instanceof MatterWriteError) throw error;
      return translate(error);
    }
  }

  async unlink(matterId: number, documentId: number) {
    try {
      const result = await this.database.query(
        `UPDATE documents SET matter_id = NULL WHERE id = $1 AND matter_id = $2`,
        [documentId, matterId]
      );
      return (result.rowCount ?? 0) > 0;
    } catch (error) {
      return translate(error);
    }
  }

  async registerFromDrive(matterId: number, input: { link: string; name: string }) {
    try {
      // 冪等：同一案件×同一 drive_link は再登録しない。
      const existing = await this.database.query(
        `SELECT id, document_number, drive_link FROM documents
          WHERE matter_id = $1 AND drive_link = $2 LIMIT 1`,
        [matterId, input.link]
      );
      if (existing.rows[0]) {
        const row = existing.rows[0];
        return { document: { id: Number(row.id), documentNumber: row.document_number, driveLink: row.drive_link ?? "" }, created: false };
      }
      const formData = JSON.stringify({ title: input.name, source: "drive" });
      const result = await this.database.query(
        `INSERT INTO documents (matter_id, template_type, drive_link, form_data, created_at)
         VALUES ($1, 'external_file', $2, $3::jsonb, now())
         RETURNING id, document_number, drive_link`,
        [matterId, input.link, formData]
      );
      const row = result.rows[0];
      return { document: { id: Number(row.id), documentNumber: row.document_number, driveLink: row.drive_link ?? "" }, created: true };
    } catch (error) {
      if (error instanceof MatterWriteError) throw error;
      return translate(error);
    }
  }
}

export class MemoryMatterDocumentWriteRepository implements MatterDocumentWriteRepository {
  constructor(
    private readonly documents: LinkedDocument[] = [],
    private readonly links: Map<number, number> = new Map()   // documentId -> matterId
  ) {}

  async link(matterId: number, documentId: number) {
    const doc = this.documents.find((d) => d.id === documentId);
    if (!doc) throw new MatterWriteError("MATTER_DOCUMENT_NOT_FOUND", "文書が見つかりません");
    this.links.set(documentId, matterId);
    return doc;
  }

  async unlink(matterId: number, documentId: number) {
    if (this.links.get(documentId) !== matterId) return false;
    this.links.delete(documentId);
    return true;
  }

  async registerFromDrive(matterId: number, input: { link: string; name: string }) {
    const existing = this.documents.find((d) => d.driveLink === input.link && this.links.get(d.id) === matterId);
    if (existing) return { document: existing, created: false };
    const id = (this.documents.reduce((max, d) => Math.max(max, d.id), 0)) + 1;
    const document: LinkedDocument = { id, documentNumber: null, driveLink: input.link };
    this.documents.push(document);
    this.links.set(id, matterId);
    return { document, created: true };
  }
}
