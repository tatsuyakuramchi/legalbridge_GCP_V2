import type { DatabasePool } from "../db/pool.js";
import type { MatterDeleteInput } from "./matter-delete-schema.js";

// 案件・タスクの削除（破壊的・Phase 8-6・S-E で影響列挙を V1 全子表に拡張）。
//   案件削除は `DELETE FROM matters` を実行し、FK 参照アクションで
//     matter_issues / matter_tasks / matter_slack_threads（V1）を連鎖削除（CASCADE）、
//     documents.matter_id / document_sends.matter_id / document_files.matter_id を解除（SET NULL）。
//   参照アクションは PostgreSQL 内部で実行されるため、削除ロールに参照先表の権限は不要。
//   加えて V2 独自の lb_v2_matter_slack_threads は FK を持たない（監査 P0-10）ため、同一
//   トランザクションで明示 DELETE する（grant 042。未付与環境では skip し孤児は 042 適用時に一掃）。
//   タスク単体削除は matter_tasks の DELETE を用い、代表タスク（is_primary）は拒否する。
//   実行が要する権限：matters / matter_tasks の DELETE（grant 029）＋lb_v2 スレッド行 DELETE（grant 042）。

export class MatterDeleteError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export interface MatterRef {
  id: number; matterCode: string | null; title: string; status: string;
}
export interface DeleteImpact { key: string; label: string; count: number | null; effect: "cascade" | "unlink"; }
export interface MatterDeletePreview { matter: MatterRef; impacts: DeleteImpact[]; }
export interface MatterDeleteResult {
  deletedId: number;
  cascaded: { issues: number; tasks: number; slackThreads: number | null };
  unlinked: { documents: number; sends: number; files: number | null };
  // V2 独自スレッド記録の削除件数。DELETE 権限（grant 042）未付与の環境では null（skip）。
  v2SlackThreads: number | null;
}
export interface MatterTaskDeleteResult { deletedId: number; matterId: number }

const IMPACTS: Array<{ key: string; table: string; label: string; effect: "cascade" | "unlink" }> = [
  { key: "issues", table: "matter_issues", label: "関連課題リンク", effect: "cascade" },
  { key: "tasks", table: "matter_tasks", label: "タスク", effect: "cascade" },
  { key: "slackThreads", table: "matter_slack_threads", label: "Slack法務相談スレッド", effect: "cascade" },
  { key: "documents", table: "documents", label: "関連文書（解除）", effect: "unlink" },
  { key: "sends", table: "document_sends", label: "送信履歴（解除）", effect: "unlink" },
  { key: "files", table: "document_files", label: "文書ファイル台帳（解除）", effect: "unlink" },
  { key: "v2SlackThreads", table: "lb_v2_matter_slack_threads", label: "V2 Slackスレッド記録", effect: "cascade" }
];

function toRef(row: Record<string, unknown> | undefined): MatterRef | null {
  if (!row) return null;
  return {
    id: Number(row.id), matterCode: row.matter_code == null ? null : String(row.matter_code),
    title: String(row.title ?? ""), status: String(row.status ?? "")
  };
}

export interface MatterDeleteRepository {
  preview(id: number): Promise<MatterDeletePreview>;
  deleteMatter(id: number, input: MatterDeleteInput): Promise<MatterDeleteResult>;
  deleteTask(matterId: number, taskId: number): Promise<MatterTaskDeleteResult>;
}

export class PgMatterDeleteRepository implements MatterDeleteRepository {
  constructor(private readonly database: DatabasePool) {}

  private async countFor(table: string, matterId: number): Promise<number | null> {
    try {
      const r = await this.database.query(`SELECT count(*) AS c FROM ${table} WHERE matter_id = $1`, [matterId]);
      return Number(r.rows[0]?.c ?? 0);
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === "42501" || code === "42P01" || code === "42703") return null;
      throw error;
    }
  }

  async preview(id: number): Promise<MatterDeletePreview> {
    const r = await this.database.query(`SELECT id, matter_code, title, status FROM matters WHERE id = $1`, [id]);
    const matter = toRef(r.rows[0]);
    if (!matter) throw new MatterDeleteError("MATTER_DELETE_NOT_FOUND", "案件が見つかりません");
    const impacts: DeleteImpact[] = await Promise.all(IMPACTS.map(async (m) => ({
      key: m.key, label: m.label, effect: m.effect, count: await this.countFor(m.table, id)
    })));
    return { matter, impacts };
  }

  async deleteMatter(id: number, _input: MatterDeleteInput): Promise<MatterDeleteResult> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const m = await client.query(`SELECT id FROM matters WHERE id = $1 FOR UPDATE`, [id]);
      if (!m.rows.length) throw new MatterDeleteError("MATTER_DELETE_NOT_FOUND", "案件が見つかりません");
      // 連鎖・解除される件数を削除前に確定する（監査ログ用）。SELECT 権限が無い表は
      // SAVEPOINT で巻き戻して null（不明）とし、削除自体は止めない。
      const counts: Array<{ key: string; count: number | null }> = [];
      for (const i of IMPACTS) {
        await client.query("SAVEPOINT impact_count");
        try {
          const r = await client.query(`SELECT count(*) AS c FROM ${i.table} WHERE matter_id = $1`, [id]);
          counts.push({ key: i.key, count: Number(r.rows[0]?.c ?? 0) });
        } catch (error) {
          const code = (error as { code?: string })?.code;
          if (code !== "42501" && code !== "42P01" && code !== "42703") throw error;
          await client.query("ROLLBACK TO SAVEPOINT impact_count");
          counts.push({ key: i.key, count: null });
        }
      }
      const byKey = (k: string) => counts.find((c) => c.key === k)?.count ?? null;
      // V2 独自スレッド記録は FK が無いため明示削除（P0-10）。grant 042 未適用なら skip
      // （孤児は 042 適用時の一掃 DELETE で回収される）。
      let v2SlackThreads: number | null = null;
      await client.query("SAVEPOINT v2_threads");
      try {
        const r = await client.query(`DELETE FROM lb_v2_matter_slack_threads WHERE matter_id = $1`, [id]);
        v2SlackThreads = r.rowCount ?? 0;
      } catch (error) {
        const code = (error as { code?: string })?.code;
        if (code !== "42501" && code !== "42P01") throw error;
        await client.query("ROLLBACK TO SAVEPOINT v2_threads");
      }
      // matters の DELETE のみ。FK 参照アクションで子行を連鎖削除／解除する。
      await client.query(`DELETE FROM matters WHERE id = $1`, [id]);
      await client.query("COMMIT");
      return {
        deletedId: id,
        cascaded: { issues: byKey("issues") ?? 0, tasks: byKey("tasks") ?? 0, slackThreads: byKey("slackThreads") },
        unlinked: { documents: byKey("documents") ?? 0, sends: byKey("sends") ?? 0, files: byKey("files") },
        v2SlackThreads
      };
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof MatterDeleteError) throw error;
      const code = (error as { code?: string })?.code;
      if (code === "42501") throw new MatterDeleteError("MATTER_DELETE_FORBIDDEN_DB", "案件削除に必要な DELETE 権限（grant 029）が未付与です");
      if (code === "23503") throw new MatterDeleteError("MATTER_DELETE_REFERENCED", "参照が残っているため削除できません（RESTRICT）");
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      client.release();
    }
  }

  async deleteTask(matterId: number, taskId: number): Promise<MatterTaskDeleteResult> {
    try {
      const found = await this.database.query(
        `SELECT id, is_primary FROM matter_tasks WHERE matter_id = $1 AND id = $2`, [matterId, taskId]);
      if (!found.rows.length) throw new MatterDeleteError("MATTER_TASK_NOT_FOUND", "タスクが見つかりません");
      if (Boolean(found.rows[0].is_primary)) {
        throw new MatterDeleteError("MATTER_TASK_PRIMARY", "代表タスクは削除できません（案件を削除してください）");
      }
      const r = await this.database.query(
        `DELETE FROM matter_tasks WHERE matter_id = $1 AND id = $2 AND is_primary = FALSE RETURNING id`,
        [matterId, taskId]);
      if (!r.rows.length) throw new MatterDeleteError("MATTER_TASK_NOT_FOUND", "タスクが見つかりません");
      return { deletedId: taskId, matterId };
    } catch (error) {
      if (error instanceof MatterDeleteError) throw error;
      const code = (error as { code?: string })?.code;
      if (code === "42501") throw new MatterDeleteError("MATTER_DELETE_FORBIDDEN_DB", "タスク削除に必要な DELETE 権限（grant 029）が未付与です");
      throw error instanceof Error ? error : new Error(String(error));
    }
  }
}

export interface MemoryTask { id: number; matterId: number; isPrimary: boolean }
export class MemoryMatterDeleteRepository implements MatterDeleteRepository {
  constructor(
    readonly matters = new Map<number, MatterRef>(),
    readonly tasks = new Map<number, MemoryTask>(),
    private readonly counts = new Map<number, Partial<Record<string, number>>>()
  ) {}

  async preview(id: number): Promise<MatterDeletePreview> {
    const matter = this.matters.get(id);
    if (!matter) throw new MatterDeleteError("MATTER_DELETE_NOT_FOUND", "案件が見つかりません");
    const c = this.counts.get(id) ?? {};
    const impacts = IMPACTS.map((m) => ({ key: m.key, label: m.label, effect: m.effect, count: c[m.key] ?? 0 }));
    return { matter, impacts };
  }

  async deleteMatter(id: number, _input: MatterDeleteInput): Promise<MatterDeleteResult> {
    const matter = this.matters.get(id);
    if (!matter) throw new MatterDeleteError("MATTER_DELETE_NOT_FOUND", "案件が見つかりません");
    const c = this.counts.get(id) ?? {};
    this.matters.delete(id);
    for (const [tid, t] of this.tasks) if (t.matterId === id) this.tasks.delete(tid);
    return {
      deletedId: id,
      cascaded: { issues: c.issues ?? 0, tasks: c.tasks ?? 0, slackThreads: c.slackThreads ?? 0 },
      unlinked: { documents: c.documents ?? 0, sends: c.sends ?? 0, files: c.files ?? 0 },
      v2SlackThreads: c.v2SlackThreads ?? 0
    };
  }

  async deleteTask(matterId: number, taskId: number): Promise<MatterTaskDeleteResult> {
    const task = this.tasks.get(taskId);
    if (!task || task.matterId !== matterId) throw new MatterDeleteError("MATTER_TASK_NOT_FOUND", "タスクが見つかりません");
    if (task.isPrimary) throw new MatterDeleteError("MATTER_TASK_PRIMARY", "代表タスクは削除できません（案件を削除してください）");
    this.tasks.delete(taskId);
    return { deletedId: taskId, matterId };
  }
}
