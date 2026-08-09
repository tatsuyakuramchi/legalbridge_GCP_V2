import type { DatabasePool } from "../db/pool.js";
import type { MatterMergeInput } from "./matter-merge-schema.js";

// 案件マージ（名寄せ）。source の紐付き（課題/タスク/文書/送信履歴）を target へ移送し、
// source をアーカイブ（status='archived'）する。DELETE しない（監査保持）。
// プレビューは SELECT のみ（新規GRANT不要）。実行が要する UPDATE 権限：
//   matter_issues(025) / matter_tasks(008) / documents.matter_id(026) /
//   document_sends.matter_id(028) / matters(008)。Drive フォルダは target が未設定のとき
//   source のフォルダを DB 上で引き継ぐ（Drive API 移動は行わない）。

export class MatterMergeError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export interface MatterRef {
  id: number; matterCode: string | null; title: string; status: string;
  driveFolderId: string | null;
}
export interface MergeCount { key: string; label: string; count: number | null; }
export interface MatterMergePreview {
  target: MatterRef; source: MatterRef; counts: MergeCount[]; totalMovable: number;
}
export interface MatterMergeResult {
  targetId: number; sourceId: number;
  moved: Array<{ key: string; count: number }>;
  totalMoved: number;
  folderAction: "none" | "adopted";
  sourceArchived: boolean;
}

const MOVABLE: Array<{ key: string; table: string; label: string }> = [
  { key: "issues", table: "matter_issues", label: "関連課題" },
  { key: "tasks", table: "matter_tasks", label: "タスク" },
  { key: "documents", table: "documents", label: "関連文書" },
  { key: "sends", table: "document_sends", label: "送信履歴" }
];

function toRef(row: Record<string, unknown> | undefined): MatterRef | null {
  if (!row) return null;
  return {
    id: Number(row.id), matterCode: row.matter_code == null ? null : String(row.matter_code),
    title: String(row.title ?? ""), status: String(row.status ?? ""),
    driveFolderId: row.drive_folder_id == null ? null : String(row.drive_folder_id)
  };
}

export interface MatterMergeRepository {
  preview(targetId: number, sourceId: number): Promise<MatterMergePreview>;
  merge(input: MatterMergeInput): Promise<MatterMergeResult>;
}

export class PgMatterMergeRepository implements MatterMergeRepository {
  constructor(private readonly database: DatabasePool) {}

  private async fetchMatter(id: number): Promise<MatterRef | null> {
    const r = await this.database.query(
      `SELECT id, matter_code, title, status, drive_folder_id FROM matters WHERE id = $1`, [id]);
    return toRef(r.rows[0]);
  }

  async preview(targetId: number, sourceId: number): Promise<MatterMergePreview> {
    const [target, source] = await Promise.all([this.fetchMatter(targetId), this.fetchMatter(sourceId)]);
    if (!target) throw new MatterMergeError("MATTER_MERGE_TARGET_NOT_FOUND", "存続先の案件が見つかりません");
    if (!source) throw new MatterMergeError("MATTER_MERGE_SOURCE_NOT_FOUND", "統合元の案件が見つかりません");
    const counts: MergeCount[] = await Promise.all(MOVABLE.map(async (m) => {
      try {
        const r = await this.database.query(
          `SELECT count(*) AS c FROM ${m.table} WHERE matter_id = $1`, [sourceId]);
        return { key: m.key, label: m.label, count: Number(r.rows[0]?.c ?? 0) };
      } catch (error) {
        const code = (error as { code?: string })?.code;
        if (code === "42501" || code === "42P01" || code === "42703") return { key: m.key, label: m.label, count: null };
        throw error;
      }
    }));
    const totalMovable = counts.reduce((s, c) => s + (c.count ?? 0), 0);
    return { target, source, counts, totalMovable };
  }

  async merge(input: MatterMergeInput): Promise<MatterMergeResult> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const t = await client.query(`SELECT id, drive_folder_id FROM matters WHERE id = $1 FOR UPDATE`, [input.targetId]);
      if (!t.rows.length) throw new MatterMergeError("MATTER_MERGE_TARGET_NOT_FOUND", "存続先の案件が見つかりません");
      const s = await client.query(`SELECT id, drive_folder_id, drive_folder_url FROM matters WHERE id = $1 FOR UPDATE`, [input.sourceId]);
      if (!s.rows.length) throw new MatterMergeError("MATTER_MERGE_SOURCE_NOT_FOUND", "統合元の案件が見つかりません");

      const moved: Array<{ key: string; count: number }> = [];
      // 課題：衝突（同一 backlog_issue_key）は source 側に残す（target を優先）。
      const issues = await client.query(
        `UPDATE matter_issues mi SET matter_id = $1
          WHERE mi.matter_id = $2
            AND NOT EXISTS (SELECT 1 FROM matter_issues x WHERE x.matter_id = $1 AND x.backlog_issue_key = mi.backlog_issue_key)`,
        [input.targetId, input.sourceId]);
      moved.push({ key: "issues", count: issues.rowCount ?? 0 });
      // タスク：target に既存 primary があるため移動分は is_primary=FALSE へ降格。
      const tasks = await client.query(
        `UPDATE matter_tasks SET matter_id = $1, is_primary = FALSE, updated_at = now() WHERE matter_id = $2`,
        [input.targetId, input.sourceId]);
      moved.push({ key: "tasks", count: tasks.rowCount ?? 0 });
      const docs = await client.query(`UPDATE documents SET matter_id = $1 WHERE matter_id = $2`, [input.targetId, input.sourceId]);
      moved.push({ key: "documents", count: docs.rowCount ?? 0 });
      const sends = await client.query(`UPDATE document_sends SET matter_id = $1 WHERE matter_id = $2`, [input.targetId, input.sourceId]);
      moved.push({ key: "sends", count: sends.rowCount ?? 0 });

      // Drive フォルダ：target 未設定かつ source 設定済なら DB 上で引き継ぐ。
      let folderAction: "none" | "adopted" = "none";
      const targetFolder = t.rows[0].drive_folder_id;
      const sourceFolder = s.rows[0].drive_folder_id;
      if (!targetFolder && sourceFolder) {
        await client.query(
          `UPDATE matters SET drive_folder_id = $2, drive_folder_url = $3, updated_at = now() WHERE id = $1`,
          [input.targetId, sourceFolder, s.rows[0].drive_folder_url ?? null]);
        folderAction = "adopted";
      }

      const archived = await client.query(
        `UPDATE matters SET status = 'archived', updated_at = now() WHERE id = $1`, [input.sourceId]);
      await client.query("COMMIT");
      return {
        targetId: input.targetId, sourceId: input.sourceId, moved,
        totalMoved: moved.reduce((sum, m) => sum + m.count, 0),
        folderAction, sourceArchived: (archived.rowCount ?? 0) > 0
      };
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof MatterMergeError) throw error;
      const code = (error as { code?: string })?.code;
      if (code === "42501") {
        throw new MatterMergeError("MATTER_MERGE_FORBIDDEN_DB", "マージに必要な UPDATE 権限が未付与です（025/026/028/008）");
      }
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      client.release();
    }
  }
}

export class MemoryMatterMergeRepository implements MatterMergeRepository {
  constructor(
    readonly matters = new Map<number, MatterRef>(),
    private readonly counts = new Map<number, Partial<Record<string, number>>>()
  ) {}

  async preview(targetId: number, sourceId: number): Promise<MatterMergePreview> {
    const target = this.matters.get(targetId);
    const source = this.matters.get(sourceId);
    if (!target) throw new MatterMergeError("MATTER_MERGE_TARGET_NOT_FOUND", "存続先の案件が見つかりません");
    if (!source) throw new MatterMergeError("MATTER_MERGE_SOURCE_NOT_FOUND", "統合元の案件が見つかりません");
    const c = this.counts.get(sourceId) ?? {};
    const counts = MOVABLE.map((m) => ({ key: m.key, label: m.label, count: c[m.key] ?? 0 }));
    return { target, source, counts, totalMovable: counts.reduce((s, x) => s + (x.count ?? 0), 0) };
  }

  async merge(input: MatterMergeInput): Promise<MatterMergeResult> {
    const target = this.matters.get(input.targetId);
    const source = this.matters.get(input.sourceId);
    if (!target) throw new MatterMergeError("MATTER_MERGE_TARGET_NOT_FOUND", "存続先の案件が見つかりません");
    if (!source) throw new MatterMergeError("MATTER_MERGE_SOURCE_NOT_FOUND", "統合元の案件が見つかりません");
    const c = this.counts.get(input.sourceId) ?? {};
    const moved = MOVABLE.map((m) => ({ key: m.key, count: c[m.key] ?? 0 }));
    let folderAction: "none" | "adopted" = "none";
    if (!target.driveFolderId && source.driveFolderId) {
      this.matters.set(input.targetId, { ...target, driveFolderId: source.driveFolderId });
      folderAction = "adopted";
    }
    this.matters.set(input.sourceId, { ...source, status: "archived" });
    return {
      targetId: input.targetId, sourceId: input.sourceId, moved,
      totalMoved: moved.reduce((s, m) => s + m.count, 0), folderAction, sourceArchived: true
    };
  }
}
