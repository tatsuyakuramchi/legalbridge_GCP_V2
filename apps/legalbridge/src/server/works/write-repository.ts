import type { DatabasePool } from "../db/pool.js";
import type { WorkCreateInput, WorkUpdateInput } from "./write-schema.js";

export interface SavedWork { id: number; workCode: string | null; }
export interface WorkRecord {
  id: number; title: string; workCode: string | null;
  ledgerCode: string | null; remarks: string | null; isActive: boolean;
}

export class WorkWriteError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export interface WorkWriteRepository {
  create(input: WorkCreateInput): Promise<SavedWork>;
  update(id: number, input: WorkUpdateInput): Promise<SavedWork>;
  find(id: number): Promise<WorkRecord | null>;
}

const COLUMNS: Record<string, string> = {
  title: "title", workCode: "work_code", ledgerCode: "ledger_code",
  remarks: "remarks", isActive: "is_active"
};

export class PgWorkWriteRepository implements WorkWriteRepository {
  constructor(private readonly database: DatabasePool) {}

  async create(input: WorkCreateInput) {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const columns: string[] = [];
      const values: unknown[] = [];
      for (const [key, column] of Object.entries(COLUMNS)) {
        const value = (input as Record<string, unknown>)[key];
        if (value === undefined) continue;
        columns.push(column); values.push(value);
      }
      const hasCode = columns.includes("work_code");
      const placeholders = values.map((_, index) => `$${index + 1}`);
      const inserted = await client.query(
        `INSERT INTO works (${columns.join(", ")}${hasCode ? "" : ", work_code"})
         VALUES (${placeholders.join(", ")}${hasCode ? "" : ", 'PENDING'"})
         RETURNING id, work_code`,
        values
      );
      const id = Number(inserted.rows[0].id);
      let workCode: string | null = inserted.rows[0].work_code ?? null;
      if (!hasCode) {
        const numbered = await client.query(
          `UPDATE works SET work_code = 'WRK-' || lpad(id::text, 5, '0')
            WHERE id = $1 RETURNING work_code`, [id]);
        workCode = numbered.rows[0]?.work_code ?? workCode;
      }
      await client.query("COMMIT");
      return { id, workCode };
    } catch (error) {
      await client.query("ROLLBACK");
      throw translate(error);
    } finally {
      client.release();
    }
  }

  async update(id: number, input: WorkUpdateInput) {
    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(COLUMNS)) {
      const value = (input as Record<string, unknown>)[key];
      if (value === undefined) continue;
      values.push(value); assignments.push(`${column} = $${values.length}`);
    }
    values.push(id);
    try {
      const result = await this.database.query(
        `UPDATE works SET ${assignments.join(", ")} WHERE id = $${values.length}
         RETURNING id, work_code`, values);
      if (!result.rows[0]) throw new WorkWriteError("WORK_NOT_FOUND", "指定した作品が見つかりません");
      return { id: Number(result.rows[0].id), workCode: result.rows[0].work_code ?? null };
    } catch (error) { throw translate(error); }
  }

  async find(id: number) {
    const result = await this.database.query(
      `SELECT id, title, work_code, ledger_code, remarks, is_active FROM works WHERE id = $1`, [id]);
    if (!result.rows[0]) return null;
    const row = result.rows[0];
    return {
      id: Number(row.id), title: String(row.title ?? ""), workCode: row.work_code ?? null,
      ledgerCode: row.ledger_code ?? null, remarks: row.remarks ?? null, isActive: Boolean(row.is_active)
    };
  }
}

function translate(error: unknown): Error {
  if (error instanceof WorkWriteError) return error;
  const code = (error as { code?: string })?.code;
  if (code === "23505") return new WorkWriteError("WORK_CONFLICT", "作品コードが既に存在します");
  if (code === "23502") return new WorkWriteError("WORK_REQUIRED", "必須項目が不足しています");
  return error instanceof Error ? error : new Error(String(error));
}

export class MemoryWorkWriteRepository implements WorkWriteRepository {
  private seq = 0;
  readonly works = new Map<number, WorkRecord>();
  async create(input: WorkCreateInput) {
    const id = ++this.seq;
    const workCode = input.workCode ?? `WRK-${String(id).padStart(5, "0")}`;
    this.works.set(id, {
      id, title: input.title, workCode, ledgerCode: input.ledgerCode ?? null,
      remarks: input.remarks ?? null, isActive: input.isActive
    });
    return { id, workCode };
  }
  async update(id: number, input: WorkUpdateInput) {
    const existing = this.works.get(id);
    if (!existing) throw new WorkWriteError("WORK_NOT_FOUND", "指定した作品が見つかりません");
    Object.assign(existing, input);
    return { id, workCode: existing.workCode };
  }
  async find(id: number) { return this.works.get(id) ?? null; }
}
