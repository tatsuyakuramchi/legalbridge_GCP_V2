import { inTransaction, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { DocumentRepository } from "./repository.js";
import { DocumentIssueService } from "./issue-service.js";
import type { PdfRenderer } from "./pdf-renderer.js";
import type { DriveStorage } from "./drive-storage.js";

export interface StoreResult {
  documentId: number;
  documentNo: string | null;
  storageUrl: string;
  /** 既存ファイルを差し替えたか、新規に作ったか。 */
  mode: "created" | "replaced" | "unchanged";
}

/** Drive 上のファイル名。日本語や記号はIDに使えないため落とす（V2 と同じ規則）。 */
export function safeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "document";
}

/**
 * 発行済み文書の Drive 保存。
 *
 * 冪等にするため、まず Drive 側で同じ文書IDのファイルを探す。
 * あれば中身だけ差し替えてリンクを保つ（再発行でリンクが変わると、
 * 送付済みメールや CloudSign の参照が切れるため）。
 */
export class DocumentStorageService {
  private readonly repository: DocumentRepository;
  private readonly issues: DocumentIssueService;

  constructor(
    private readonly database: Transactable,
    private readonly drive: DriveStorage | null,
    private readonly pdf: PdfRenderer
  ) {
    this.repository = new DocumentRepository(database);
    this.issues = new DocumentIssueService(database);
  }

  get configured(): boolean { return this.drive !== null; }

  async store(documentId: number, actor: string, options: { force?: boolean } = {}): Promise<StoreResult> {
    if (!this.drive) {
      throw new DomainError("DB_FORBIDDEN", "Drive 保存が設定されていません（GOOGLE_DRIVE_FOLDER_ID）");
    }
    const document = await this.repository.find(documentId);
    if (!document) throw new DomainError("NOT_FOUND", `文書 ${documentId} が見つかりません`);
    if (document.status !== "issued") {
      throw new DomainError("CONFLICT", "発行済みの文書だけを保存できます");
    }
    if (document.storageUrl && !options.force) {
      return {
        documentId, documentNo: document.documentNo,
        storageUrl: document.storageUrl, mode: "unchanged"
      };
    }

    try {
      const rendered = await this.issues.renderIssued(documentId);
      const pdf = await this.pdf.render(rendered.html);
      const filename = `${safeFilename(document.documentNo ?? `document-${documentId}`)}.pdf`;

      const existing = await this.drive.findByDocumentId(documentId);
      const file = existing
        ? await this.drive.updatePdf({ fileId: existing.id, pdf })
        : await this.drive.uploadPdf({ documentId, filename, pdf });
      const mode: StoreResult["mode"] = existing ? "replaced" : "created";

      await inTransaction(this.database, async (client) => {
        await client.query(
          "UPDATE documents SET storage_url = $2 WHERE id = $1", [documentId, file.webViewLink]);
        await recordAudit(client, {
          actor, action: "document.store", targetType: "document", targetId: documentId,
          detail: { documentNo: document.documentNo, filename, mode, fileId: file.id, bytes: pdf.length }
        });
      });

      return { documentId, documentNo: document.documentNo, storageUrl: file.webViewLink, mode };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      // Drive 側の失敗は文書の状態を変えない。理由をそのまま返して再実行できるようにする。
      throw new DomainError("DB_FORBIDDEN",
        `Drive への保存に失敗しました: ${String((error as Error)?.message ?? error).slice(0, 300)}`);
    }
  }
}
