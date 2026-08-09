import type { DatabasePool } from "../db/pool.js";
import type { MatterDeleteInput } from "./matter-delete-schema.js";

// 案件・タスクの削除（破壊的・Phase 8-6）。
//   案件削除は `DELETE FROM matters` のみを実行し、FK 参照アクションで
//     matter_issues / matter_tasks を連鎖削除（CASCADE）、
//     documents.matter_id / document_sends.matter_id を解除（SET NULL）する。
//   参照アクションは PostgreSQL 内部で実行されるため、削除ロールに参照先表の権限は不要。
//   タスク単体削除は matter_tasks の DELETE を用い、代表タスク（is_primary）は拒否する。
//   実行が要する権限：matters / matter_tasks の DELETE（grant 029）。

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
  cascaded: { issues: number; tasks: number };
  unlinked: { documents: number; sends: number };
}
export interface MatterTaskDeleteResult { deletedId: number; matterId: number }

const IMPACTS: Array<{ key: string; table: string; label: string; effect: "cascade" | "unlink" }> = [
  { key: "issues", table: "matter_issues", label: "関連課題リンク", effect: "cascade" },
  { key: "tasks", table: "matter_tasks", label: "タスク", effect: "cascade" },
  { key: "documents", table: "documents", label: "関連文書（解除）", effect: "unlink" },
  { key: "sends", table: "document_sends", label: "送信履歴（解除）", effect: "unlink" }
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
      // 連鎖・解除される件数を削除前に確定する（監査ログ用）。
      const counts = await Promise.all(IMPACTS.map(async (i) => {
        const r = await client.query(`SELECT count(*) AS c FROM ${i.table} WHERE matter_id = $1`, [id]);
        return { key: i.key, count: Number(r.rows[0]?.c ?? 0) };
      }));
      const byKey = (k: string) => counts.find((c) => c.key === k)?.count ?? 0;
      // matters の DELETE のみ。FK 参照アクションで子行を連鎖削除／解除する。
      await client.query(`DELETE FROM matters WHERE id = $1`, [id]);
      await client.query("COMMIT");
      return {
        deletedId: id,
        cascaded: { issues: byKey("issues"), tasks: byKey("tasks") },
        unlinked: { documents: byKey("documents"), sends: byKey("sends") }
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
      cascaded: { issues: c.issues ?? 0, tasks: c.tasks ?? 0 },
      unlinked: { documents: c.documents ?? 0, sends: c.sends ?? 0 }
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
