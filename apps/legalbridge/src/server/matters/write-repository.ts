import type { PoolClient } from "pg";
import type { DatabasePool } from "../db/pool.js";
import type {
  MatterCreateInput, MatterUpdateInput, TaskCreateInput, TaskUpdateInput
} from "./write-schema.js";

export interface CreatedMatter {
  id: number;
  matterCode: string | null;
}
export interface CreatedTask {
  id: number;
  matterId: number;
  isPrimary: boolean;
}

export class MatterWriteError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export interface MatterWriteRepository {
  createMatter(input: MatterCreateInput, createdBy: string): Promise<CreatedMatter>;
  updateMatter(id: number, input: MatterUpdateInput, actor: string): Promise<CreatedMatter>;
  createTask(matterId: number, input: TaskCreateInput, createdBy: string): Promise<CreatedTask>;
  updateTask(matterId: number, taskId: number, input: TaskUpdateInput): Promise<CreatedTask>;
}

// Map camelCase input fields to the DB column set used on both create and update.
const MATTER_COLUMNS: Record<string, string> = {
  title: "title",
  status: "status",
  lifecycleStage: "lifecycle_stage",
  ownerStaffId: "owner_staff_id",
  counterparty: "counterparty",
  primaryIssueKey: "primary_issue_key",
  targetDueDate: "target_due_date",
  blockedReason: "blocked_reason",
  remarks: "remarks",
  matterCode: "matter_code",
  completionReason: "completion_reason"
};
const TASK_COLUMNS: Record<string, string> = {
  title: "title",
  taskType: "task_type",
  description: "description",
  assigneeStaffId: "assignee_staff_id",
  dueAt: "due_at",
  status: "status",
  blockedReason: "blocked_reason"
};

export class PgMatterWriteRepository implements MatterWriteRepository {
  constructor(private readonly database: DatabasePool) {}

  async createMatter(input: MatterCreateInput, createdBy: string) {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const columns = ["created_by"];
      const values: unknown[] = [createdBy];
      for (const [key, column] of Object.entries(MATTER_COLUMNS)) {
        const value = (input as Record<string, unknown>)[key];
        if (value === undefined) continue;
        columns.push(column);
        values.push(value);
      }
      const placeholders = values.map((_, index) => `$${index + 1}`);
      const inserted = await client.query(
        `INSERT INTO matters (${columns.join(", ")})
         VALUES (${placeholders.join(", ")})
         RETURNING id, matter_code`,
        values
      );
      const row = inserted.rows[0];
      const id = Number(row.id);
      let matterCode: string | null = row.matter_code ?? null;
      // Auto-number when the caller did not supply an explicit code.
      if (!matterCode) {
        const numbered = await client.query(
          `UPDATE matters
              SET matter_code = 'MTR-' || to_char(created_at, 'YYYY') || '-' || lpad(id::text, 5, '0')
            WHERE id = $1 AND matter_code IS NULL
            RETURNING matter_code`,
          [id]
        );
        matterCode = numbered.rows[0]?.matter_code ?? null;
      }
      await client.query("COMMIT");
      return { id, matterCode };
    } catch (error) {
      await client.query("ROLLBACK");
      throw translateDbError(error);
    } finally {
      client.release();
    }
  }

  async updateMatter(id: number, input: MatterUpdateInput, actor: string) {
    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(MATTER_COLUMNS)) {
      const value = (input as Record<string, unknown>)[key];
      if (value === undefined) continue;
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    }
    // Stamp completion metadata when moving to a closed state.
    if (input.status === "closed") {
      values.push(actor);
      assignments.push(`completed_at = now()`, `completed_by = $${values.length}`);
    }
    assignments.push("updated_at = now()");
    values.push(id);
    const result = await this.database.query(
      `UPDATE matters SET ${assignments.join(", ")}
        WHERE id = $${values.length}
        RETURNING id, matter_code`,
      values
    );
    if (!result.rows[0]) {
      throw new MatterWriteError("MATTER_NOT_FOUND", "指定した案件が見つかりません");
    }
    return { id: Number(result.rows[0].id), matterCode: result.rows[0].matter_code ?? null };
  }

  async createTask(matterId: number, input: TaskCreateInput, createdBy: string) {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      await ensureMatterExists(client, matterId);
      if (input.isPrimary) await clearPrimaryTask(client, matterId);
      const columns = ["matter_id", "created_by", "is_primary"];
      const values: unknown[] = [matterId, createdBy, input.isPrimary];
      for (const [key, column] of Object.entries(TASK_COLUMNS)) {
        const value = (input as Record<string, unknown>)[key];
        if (value === undefined) continue;
        columns.push(column);
        values.push(value);
      }
      if (input.status === "done") {
        columns.push("completed_at");
        values.push(new Date().toISOString());
      }
      const placeholders = values.map((_, index) => `$${index + 1}`);
      const inserted = await client.query(
        `INSERT INTO matter_tasks (${columns.join(", ")})
         VALUES (${placeholders.join(", ")})
         RETURNING id, is_primary`,
        values
      );
      await client.query("COMMIT");
      const row = inserted.rows[0];
      return { id: Number(row.id), matterId, isPrimary: Boolean(row.is_primary) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw translateDbError(error);
    } finally {
      client.release();
    }
  }

  async updateTask(matterId: number, taskId: number, input: TaskUpdateInput) {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      if (input.isPrimary === true) await clearPrimaryTask(client, matterId, taskId);
      const assignments: string[] = [];
      const values: unknown[] = [];
      for (const [key, column] of Object.entries(TASK_COLUMNS)) {
        const value = (input as Record<string, unknown>)[key];
        if (value === undefined) continue;
        values.push(value);
        assignments.push(`${column} = $${values.length}`);
      }
      if (input.isPrimary !== undefined) {
        values.push(input.isPrimary);
        assignments.push(`is_primary = $${values.length}`);
      }
      if (input.status === "done") {
        assignments.push("completed_at = COALESCE(completed_at, now())");
      }
      assignments.push("updated_at = now()");
      values.push(matterId);
      values.push(taskId);
      const result = await client.query(
        `UPDATE matter_tasks SET ${assignments.join(", ")}
          WHERE matter_id = $${values.length - 1} AND id = $${values.length}
          RETURNING id, is_primary`,
        values
      );
      if (!result.rows[0]) {
        throw new MatterWriteError("MATTER_TASK_NOT_FOUND", "指定したタスクが見つかりません");
      }
      await client.query("COMMIT");
      const row = result.rows[0];
      return { id: Number(row.id), matterId, isPrimary: Boolean(row.is_primary) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw translateDbError(error);
    } finally {
      client.release();
    }
  }
}

async function ensureMatterExists(client: PoolClient, matterId: number) {
  const result = await client.query("SELECT 1 FROM matters WHERE id = $1", [matterId]);
  if (!result.rows[0]) {
    throw new MatterWriteError("MATTER_NOT_FOUND", "指定した案件が見つかりません");
  }
}
async function clearPrimaryTask(client: PoolClient, matterId: number, exceptTaskId?: number) {
  await client.query(
    `UPDATE matter_tasks SET is_primary = FALSE, updated_at = now()
      WHERE matter_id = $1 AND is_primary AND ($2::int IS NULL OR id <> $2)`,
    [matterId, exceptTaskId ?? null]
  );
}

function translateDbError(error: unknown): Error {
  if (error instanceof MatterWriteError) return error;
  const code = (error as { code?: string })?.code;
  if (code === "23505") {
    return new MatterWriteError("MATTER_CONFLICT", "重複する値があります（案件番号などが既に存在します）");
  }
  if (code === "23503") {
    return new MatterWriteError("MATTER_REFERENCE_INVALID", "担当者・取引先などの参照先が存在しません");
  }
  if (code === "23514") {
    return new MatterWriteError("MATTER_CHECK_FAILED", "工程・状態の値が許可されていません");
  }
  return error instanceof Error ? error : new Error(String(error));
}

export class MemoryMatterWriteRepository implements MatterWriteRepository {
  private matterSeq = 0;
  private taskSeq = 0;
  readonly matters = new Map<number, Record<string, unknown>>();
  readonly tasks = new Map<number, Record<string, unknown>>();

  async createMatter(input: MatterCreateInput) {
    const id = ++this.matterSeq;
    const matterCode = input.matterCode ?? `MTR-2026-${String(id).padStart(5, "0")}`;
    this.matters.set(id, { ...input, id, matterCode });
    return { id, matterCode };
  }
  async updateMatter(id: number, input: MatterUpdateInput) {
    const existing = this.matters.get(id);
    if (!existing) throw new MatterWriteError("MATTER_NOT_FOUND", "指定した案件が見つかりません");
    Object.assign(existing, input);
    return { id, matterCode: (existing.matterCode as string | null) ?? null };
  }
  async createTask(matterId: number, input: TaskCreateInput) {
    if (!this.matters.has(matterId)) {
      throw new MatterWriteError("MATTER_NOT_FOUND", "指定した案件が見つかりません");
    }
    if (input.isPrimary) this.unsetPrimary(matterId);
    const id = ++this.taskSeq;
    this.tasks.set(id, { ...input, id, matterId });
    return { id, matterId, isPrimary: input.isPrimary };
  }
  async updateTask(matterId: number, taskId: number, input: TaskUpdateInput) {
    const task = this.tasks.get(taskId);
    if (!task || task.matterId !== matterId) {
      throw new MatterWriteError("MATTER_TASK_NOT_FOUND", "指定したタスクが見つかりません");
    }
    if (input.isPrimary === true) this.unsetPrimary(matterId, taskId);
    Object.assign(task, input);
    return { id: taskId, matterId, isPrimary: Boolean(task.isPrimary) };
  }
  private unsetPrimary(matterId: number, exceptId?: number) {
    for (const task of this.tasks.values()) {
      if (task.matterId === matterId && task.id !== exceptId) task.isPrimary = false;
    }
  }
}
