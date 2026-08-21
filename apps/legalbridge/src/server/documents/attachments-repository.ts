import type { DatabasePool } from "../db/pool.js";

// 案件への資料添付（Phase 16-4）。V1 worker の /api/matters/:id/attachments ＋
// /api/attachments/by-issue を V2 の案件中心モデルに寄せて移植する。
// 生ファイルは Drive に格納し、documents 行（ATT-YYYY-NNNNN・is_primary=FALSE・
// lifecycle_status='final'）として案件に紐付ける。必要 grant は既存の 006
// （documents SELECT/INSERT・document_sequences・documents_id_seq）のみ＝新規 grant 不要。

export const ATTACHMENT_KINDS: Record<string, string> = {
  counterparty_draft: "相手方ドラフト",
  own_draft: "自社ドラフト",
  reference: "参考資料"
};

export interface AttachmentTargetMatter {
  id: number;
  matterCode: string | null;
  primaryIssueKey: string | null;
}

export interface RegisterAttachmentInput {
  // null = 案件未解決（ポータル経由・課題番号のみ判明）。autolink／案件同期に委ねる（V1 同様）。
  matterId: number | null;
  issueKey: string | null;
  templateType: string;          // ATTACHMENT_KINDS のキー
  driveLink: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string | null;
}

export interface RegisteredAttachment {
  id: number;
  documentNumber: string;
  templateType: string;
  driveLink: string;
  contractTitle: string;
  createdAt: string;
}

export interface AttachmentsRepository {
  findMatter(matterId: number): Promise<AttachmentTargetMatter | null>;
  register(input: RegisterAttachmentInput): Promise<RegisteredAttachment>;
}

export class PgAttachmentsRepository implements AttachmentsRepository {
  constructor(private readonly database: DatabasePool) {}

  async findMatter(matterId: number): Promise<AttachmentTargetMatter | null> {
    const result = await this.database.query(
      `SELECT id, matter_code, primary_issue_key FROM matters WHERE id = $1`,
      [matterId]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: Number(row.id),
      matterCode: row.matter_code ? String(row.matter_code) : null,
      primaryIssueKey: row.primary_issue_key ? String(row.primary_issue_key) : null
    };
  }

  async register(input: RegisterAttachmentInput): Promise<RegisteredAttachment> {
    // ATT-YYYY-NNNNN 採番（V1 と同じ document_sequences kind='attachment' を共有＝番号帯が連続する）。
    const year = new Date().getFullYear();
    const seq = await this.database.query(
      `INSERT INTO document_sequences (kind, year, current_value) VALUES ('attachment', $1, 1)
         ON CONFLICT (kind, year) DO UPDATE SET current_value = document_sequences.current_value + 1
       RETURNING current_value`,
      [year]);
    const documentNumber = `ATT-${year}-${String(Number(seq.rows[0].current_value)).padStart(5, "0")}`;

    const formData = {
      title: input.originalName,
      original_file_name: input.originalName,
      source_mime_type: input.mimeType,
      size_bytes: input.sizeBytes,
      kind: input.templateType,
      uploaded_by: input.uploadedBy,
      uploaded_via: "v2-matter-attachment"
    };
    const inserted = await this.database.query(
      `INSERT INTO documents
         (document_number, issue_key, template_type, form_data, drive_link,
          matter_id, is_primary, lifecycle_status, contract_title, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, FALSE, 'final', $7, $8)
       RETURNING id, document_number, template_type, drive_link, contract_title, created_at`,
      [
        documentNumber,
        input.issueKey ?? "",
        input.templateType,
        JSON.stringify(formData),
        input.driveLink,
        input.matterId,
        input.originalName,
        input.uploadedBy
      ]);
    const row = inserted.rows[0];

    // 案件の更新時刻を触る（一覧の並び/鮮度用・V1 同様）。matters UPDATE 権限が
    // 未付与でも添付自体は成功扱い（ベストエフォート）。
    if (input.matterId != null) {
      try {
        await this.database.query(`UPDATE matters SET updated_at = now() WHERE id = $1`, [input.matterId]);
      } catch { /* 非致命 */ }
    }

    return {
      id: Number(row.id),
      documentNumber: String(row.document_number),
      templateType: String(row.template_type),
      driveLink: String(row.drive_link ?? ""),
      contractTitle: String(row.contract_title ?? ""),
      createdAt: new Date(String(row.created_at)).toISOString()
    };
  }
}

export class MemoryAttachmentsRepository implements AttachmentsRepository {
  private sequence = 0;
  readonly registered: Array<RegisteredAttachment & { matterId: number | null; issueKey: string | null }> = [];

  constructor(
    readonly matters: AttachmentTargetMatter[] = [],
    private readonly forbidden = false
  ) {}

  async findMatter(matterId: number) {
    return this.matters.find((m) => m.id === matterId) ?? null;
  }

  async register(input: RegisterAttachmentInput): Promise<RegisteredAttachment> {
    if (this.forbidden) {
      const error = new Error("permission denied");
      (error as { code?: string }).code = "42501";
      throw error;
    }
    this.sequence += 1;
    const value = {
      id: this.sequence,
      documentNumber: `ATT-${new Date().getFullYear()}-${String(this.sequence).padStart(5, "0")}`,
      templateType: input.templateType,
      driveLink: input.driveLink,
      contractTitle: input.originalName,
      createdAt: new Date().toISOString(),
      matterId: input.matterId,
      issueKey: input.issueKey
    };
    this.registered.push(value);
    return value;
  }
}
