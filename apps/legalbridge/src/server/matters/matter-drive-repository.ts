import type { DatabasePool } from "../db/pool.js";
import { MatterWriteError } from "./write-repository.js";

// 案件の Drive フォルダ参照（matters.drive_folder_id / drive_folder_url）。
// 更新は 008 の matters UPDATE 権限で可（新規 grant 不要）。

export interface MatterFolderRef { folderId: string | null; url: string | null; }

export interface MatterDriveRepository {
  getFolder(matterId: number): Promise<MatterFolderRef | null>;
  setFolder(matterId: number, folder: { folderId: string; url: string }): Promise<void>;
}

export class PgMatterDriveRepository implements MatterDriveRepository {
  constructor(private readonly database: DatabasePool) {}

  async getFolder(matterId: number) {
    const result = await this.database.query(
      `SELECT drive_folder_id, drive_folder_url FROM matters WHERE id = $1`,
      [matterId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return { folderId: row.drive_folder_id ?? null, url: row.drive_folder_url ?? null };
  }

  async setFolder(matterId: number, folder: { folderId: string; url: string }) {
    try {
      const result = await this.database.query(
        `UPDATE matters SET drive_folder_id = $2, drive_folder_url = $3, updated_at = now() WHERE id = $1`,
        [matterId, folder.folderId, folder.url]
      );
      if ((result.rowCount ?? 0) === 0) {
        throw new MatterWriteError("MATTER_NOT_FOUND", "案件が見つかりません");
      }
    } catch (error) {
      if (error instanceof MatterWriteError) throw error;
      const code = (error as { code?: string })?.code;
      if (code === "42501") {
        throw new MatterWriteError("MATTER_DRIVE_GRANT_MISSING", "matters への更新権限がありません（grant 008 未適用）");
      }
      throw error as Error;
    }
  }
}

export class MemoryMatterDriveRepository implements MatterDriveRepository {
  constructor(private readonly folders: Map<number, MatterFolderRef> = new Map()) {}
  async getFolder(matterId: number) { return this.folders.get(matterId) ?? { folderId: null, url: null }; }
  async setFolder(matterId: number, folder: { folderId: string; url: string }) {
    this.folders.set(matterId, { folderId: folder.folderId, url: folder.url });
  }
}
