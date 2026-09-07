import { inTransaction, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { matterFolderName, type MatterDriveFolderService } from "../documents/drive-folder.js";

export interface MatterFolderResult {
  matterId: number;
  folderId: string;
  folderUrl: string;
  created: boolean;
}

/**
 * 案件ごとの Drive フォルダ。同名があれば作らずに使い回すので、
 * 何度呼んでも増えない（V2 と同じ冪等な作り）。
 */
export class MatterFolderStorageService {
  constructor(
    private readonly database: Transactable,
    private readonly folders: MatterDriveFolderService,
    private readonly parentFolderId: string
  ) {}

  get configured(): boolean {
    return this.folders.configured && Boolean(this.parentFolderId);
  }

  async ensure(matterId: number, actor: string): Promise<MatterFolderResult> {
    if (!this.configured) {
      throw new DomainError("DB_FORBIDDEN",
        "案件フォルダの作成が設定されていません（DRIVE_MATTER_PARENT_FOLDER_ID）");
    }
    try {
      const head = await this.database.query(
        "SELECT id, matter_no, title, drive_folder_url FROM matters WHERE id = $1", [matterId]);
      const row = head.rows[0] as Record<string, any> | undefined;
      if (!row) throw new DomainError("NOT_FOUND", `案件 ${matterId} が見つかりません`);
      const existingUrl = row.drive_folder_url ? String(row.drive_folder_url) : "";

      const name = matterFolderName({
        matterCode: row.matter_no ? String(row.matter_no) : null,
        matterId,
        title: String(row.title ?? "")
      });
      const folder = await this.folders.ensureFolder({ name, parentFolderId: this.parentFolderId });

      const created = existingUrl !== folder.url;
      if (created) {
        await inTransaction(this.database, async (client) => {
          await client.query(
            "UPDATE matters SET drive_folder_url = $2, updated_at = now() WHERE id = $1",
            [matterId, folder.url]);
          await recordAudit(client, {
            actor, action: "matter.drive_folder", targetType: "matter", targetId: matterId,
            detail: { name, folderId: folder.id, url: folder.url }
          });
        });
      }
      return { matterId, folderId: folder.id, folderUrl: folder.url, created };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      const translated = translate(error);
      if (translated instanceof DomainError) throw translated;
      throw new DomainError("DB_FORBIDDEN",
        `案件フォルダの作成に失敗しました: ${String((error as Error)?.message ?? error).slice(0, 300)}`);
    }
  }

  async listFiles(matterId: number) {
    if (!this.configured) return [];
    const head = await this.database.query(
      "SELECT drive_folder_url FROM matters WHERE id = $1", [matterId]);
    const url = (head.rows[0] as { drive_folder_url?: string } | undefined)?.drive_folder_url;
    const folderId = String(url ?? "").match(/\/folders\/([A-Za-z0-9_-]{10,})/)?.[1];
    if (!folderId) return [];
    return this.folders.listFiles(folderId);
  }
}
