import type { DatabasePool } from "../db/pool.js";
import type { WorkCreateInput, WorkUpdateInput } from "./write-schema.js";

export interface SavedWork { id: number; workCode: string | null; }
export interface WorkRecord {
  id: number; title: string; workCode: string | null;
  ledgerCode: string | null; remarks: string | null; isActive: boolean;
  titleKana: string | null; workType: string | null; kind: string | null;
  derivationType: string | null; isOriginal: boolean | null;
  parentWorkId: number | null; rightsHolderVendorId: number | null;
  creatorName: string | null; publisherName: string | null;
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
  remarks: "remarks", isActive: "is_active",
  titleKana: "title_kana", workType: "work_type", kind: "kind",
  derivationType: "derivation_type", isOriginal: "is_original",
  parentWorkId: "parent_work_id", rightsHolderVendorId: "rights_holder_vendor_id",
  creatorName: "creator_name", publisherName: "publisher_name"
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

  // 系譜の閉路防止：新しい親が自分自身、または自分の子孫であってはならない。
  private async assertNoCycle(id: number, parentWorkId: number) {
    if (parentWorkId === id) {
      throw new WorkWriteError("WORK_LINEAGE_CYCLE", "作品を自身の親に設定できません");
    }
    const result = await this.database.query(
      `WITH RECURSIVE up AS (
         SELECT id, parent_work_id FROM works WHERE id = $1
         UNION ALL
         SELECT w.id, w.parent_work_id FROM works w JOIN up ON w.id = up.parent_work_id
       )
       SELECT 1 FROM up WHERE id = $2 LIMIT 1`,
      [parentWorkId, id]
    );
    if (result.rows.length) {
      throw new WorkWriteError("WORK_LINEAGE_CYCLE", "系譜が循環するため、その親は設定できません");
    }
  }

  async update(id: number, input: WorkUpdateInput) {
    if (typeof input.parentWorkId === "number") await this.assertNoCycle(id, input.parentWorkId);
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
      `SELECT id, title, work_code, ledger_code, remarks, is_active, title_kana, work_type,
              kind, derivation_type, is_original, parent_work_id, rights_holder_vendor_id,
              creator_name, publisher_name
         FROM works WHERE id = $1`, [id]);
    if (!result.rows[0]) return null;
    const row = result.rows[0];
    return {
      id: Number(row.id), title: String(row.title ?? ""), workCode: row.work_code ?? null,
      ledgerCode: row.ledger_code ?? null, remarks: row.remarks ?? null, isActive: Boolean(row.is_active),
      titleKana: row.title_kana ?? null, workType: row.work_type ?? null, kind: row.kind ?? null,
      derivationType: row.derivation_type ?? null,
      isOriginal: row.is_original === null || row.is_original === undefined ? null : Boolean(row.is_original),
      parentWorkId: row.parent_work_id === null || row.parent_work_id === undefined ? null : Number(row.parent_work_id),
      rightsHolderVendorId: row.rights_holder_vendor_id === null || row.rights_holder_vendor_id === undefined ? null : Number(row.rights_holder_vendor_id),
      creatorName: row.creator_name ?? null, publisherName: row.publisher_name ?? null
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
      remarks: input.remarks ?? null, isActive: input.isActive,
      titleKana: input.titleKana ?? null, workType: input.workType ?? null, kind: input.kind ?? null,
      derivationType: input.derivationType ?? null, isOriginal: input.isOriginal ?? null,
      parentWorkId: input.parentWorkId ?? null, rightsHolderVendorId: input.rightsHolderVendorId ?? null,
      creatorName: input.creatorName ?? null, publisherName: input.publisherName ?? null
    });
    return { id, workCode };
  }
  async update(id: number, input: WorkUpdateInput) {
    const existing = this.works.get(id);
    if (!existing) throw new WorkWriteError("WORK_NOT_FOUND", "指定した作品が見つかりません");
    if (typeof input.parentWorkId === "number") {
      if (input.parentWorkId === id) throw new WorkWriteError("WORK_LINEAGE_CYCLE", "作品を自身の親に設定できません");
      // 新親から根へ遡り、自分に到達したら循環。
      let cursor: number | null = input.parentWorkId;
      const seen = new Set<number>();
      while (cursor != null && !seen.has(cursor)) {
        if (cursor === id) throw new WorkWriteError("WORK_LINEAGE_CYCLE", "系譜が循環するため、その親は設定できません");
        seen.add(cursor);
        cursor = this.works.get(cursor)?.parentWorkId ?? null;
      }
    }
    Object.assign(existing, input);
    return { id, workCode: existing.workCode };
  }
  async find(id: number) { return this.works.get(id) ?? null; }
}
