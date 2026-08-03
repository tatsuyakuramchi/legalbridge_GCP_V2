import { z } from "zod";
import type { DatabasePool } from "../db/pool.js";

const trimmed = z.string().trim();
const nullableText = (max: number) =>
  z.string().max(max).optional().nullable()
    .transform((value) => { const next = (value ?? "").trim(); return next ? next : null; });

// staff.slack_user_id is UNIQUE NOT NULL in the shared schema, so it is
// required on create.
export const staffCreateSchema = z.object({
  slackUserId: trimmed.min(1, "Slack ユーザーIDは必須です").max(50),
  staffName: trimmed.min(1, "氏名は必須です").max(255),
  email: nullableText(255),
  phone: nullableText(50),
  department: nullableText(100),
  departmentCode: nullableText(50)
});
export const staffUpdateSchema = z.object({
  slackUserId: trimmed.min(1).max(50).optional(),
  staffName: trimmed.min(1).max(255).optional(),
  email: nullableText(255).optional(),
  phone: nullableText(50).optional(),
  department: nullableText(100).optional(),
  departmentCode: nullableText(50).optional()
}).refine((value) => Object.keys(value).length > 0, {
  message: "更新するフィールドを1つ以上指定してください"
});
export type StaffCreateInput = z.infer<typeof staffCreateSchema>;
export type StaffUpdateInput = z.infer<typeof staffUpdateSchema>;

export interface StaffRecord {
  id: number;
  slackUserId: string;
  staffName: string;
  email: string | null;
  phone: string | null;
  department: string | null;
  departmentCode: string | null;
}
export interface SavedStaff { id: number; slackUserId: string; }

export class StaffWriteError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export interface StaffRepository {
  list(query: string, limit?: number): Promise<StaffRecord[]>;
  find(id: number): Promise<StaffRecord | null>;
  create(input: StaffCreateInput): Promise<SavedStaff>;
  update(id: number, input: StaffUpdateInput): Promise<SavedStaff>;
}

const COLUMNS: Record<string, string> = {
  slackUserId: "slack_user_id",
  staffName: "staff_name",
  email: "email",
  phone: "phone",
  department: "department",
  departmentCode: "department_code"
};

function mapRecord(row: Record<string, any>): StaffRecord {
  return {
    id: Number(row.id),
    slackUserId: String(row.slack_user_id ?? ""),
    staffName: String(row.staff_name ?? ""),
    email: row.email ?? null,
    phone: row.phone ?? null,
    department: row.department ?? null,
    departmentCode: row.department_code ?? null
  };
}

export class PgStaffRepository implements StaffRepository {
  constructor(private readonly database: DatabasePool) {}
  async list(query: string, limit = 200) {
    const keyword = `%${query.trim()}%`;
    const result = await this.database.query(
      `SELECT id, slack_user_id, staff_name, email, phone, department, department_code
         FROM staff
        WHERE ($1 = '%%' OR staff_name ILIKE $1 OR COALESCE(department, '') ILIKE $1
               OR COALESCE(email, '') ILIKE $1)
        ORDER BY staff_name
        LIMIT $2`,
      [keyword, Math.min(Math.max(limit, 1), 500)]
    );
    return result.rows.map(mapRecord);
  }
  async find(id: number) {
    const result = await this.database.query(
      `SELECT id, slack_user_id, staff_name, email, phone, department, department_code
         FROM staff WHERE id = $1`, [id]);
    return result.rows[0] ? mapRecord(result.rows[0]) : null;
  }
  async create(input: StaffCreateInput) {
    try {
      const columns: string[] = [];
      const values: unknown[] = [];
      for (const [key, column] of Object.entries(COLUMNS)) {
        const value = (input as Record<string, unknown>)[key];
        if (value === undefined) continue;
        columns.push(column); values.push(value);
      }
      const placeholders = values.map((_, index) => `$${index + 1}`);
      const result = await this.database.query(
        `INSERT INTO staff (${columns.join(", ")}) VALUES (${placeholders.join(", ")})
         RETURNING id, slack_user_id`, values);
      return { id: Number(result.rows[0].id), slackUserId: String(result.rows[0].slack_user_id) };
    } catch (error) { throw translate(error); }
  }
  async update(id: number, input: StaffUpdateInput) {
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
        `UPDATE staff SET ${assignments.join(", ")} WHERE id = $${values.length}
         RETURNING id, slack_user_id`, values);
      if (!result.rows[0]) throw new StaffWriteError("STAFF_NOT_FOUND", "指定した担当者が見つかりません");
      return { id: Number(result.rows[0].id), slackUserId: String(result.rows[0].slack_user_id) };
    } catch (error) { throw translate(error); }
  }
}

function translate(error: unknown): Error {
  if (error instanceof StaffWriteError) return error;
  const code = (error as { code?: string })?.code;
  if (code === "23505") return new StaffWriteError("STAFF_CONFLICT", "そのSlack ユーザーIDは既に登録されています");
  if (code === "23502") return new StaffWriteError("STAFF_REQUIRED", "必須項目が不足しています");
  return error instanceof Error ? error : new Error(String(error));
}

export class MemoryStaffRepository implements StaffRepository {
  private seq = 0;
  readonly staff = new Map<number, StaffRecord>();
  async list(query: string, limit = 200) {
    const keyword = query.trim().toLowerCase();
    return [...this.staff.values()]
      .filter((s) => !keyword || [s.staffName, s.department, s.email].some((v) => v?.toLowerCase().includes(keyword)))
      .slice(0, limit);
  }
  async find(id: number) { return this.staff.get(id) ?? null; }
  async create(input: StaffCreateInput) {
    for (const s of this.staff.values()) {
      if (s.slackUserId === input.slackUserId) throw new StaffWriteError("STAFF_CONFLICT", "そのSlack ユーザーIDは既に登録されています");
    }
    const id = ++this.seq;
    this.staff.set(id, {
      id, slackUserId: input.slackUserId, staffName: input.staffName,
      email: input.email ?? null, phone: input.phone ?? null,
      department: input.department ?? null, departmentCode: input.departmentCode ?? null
    });
    return { id, slackUserId: input.slackUserId };
  }
  async update(id: number, input: StaffUpdateInput) {
    const existing = this.staff.get(id);
    if (!existing) throw new StaffWriteError("STAFF_NOT_FOUND", "指定した担当者が見つかりません");
    Object.assign(existing, input);
    return { id, slackUserId: existing.slackUserId };
  }
}
