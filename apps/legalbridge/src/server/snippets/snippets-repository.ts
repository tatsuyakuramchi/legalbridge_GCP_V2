import { z } from "zod";
import type { DatabasePool } from "../db/pool.js";

// 定型文言（スニペット）の全社共有化（Phase 16-1・grant 045）。V1 の text_snippets（0151）を
// V2 が読み書きする。削除は V1 同様の論理削除（is_active=false）＝DELETE grant 不要。

export const SNIPPET_CATEGORIES = ["special_terms", "work_item", "other"] as const;
export const SNIPPET_CATEGORY_LABELS: Record<string, string> = {
  special_terms: "特約・備考", work_item: "業務明細", other: "その他"
};

export const snippetSaveSchema = z.object({
  id: z.number().int().positive().optional(),
  category: z.enum(SNIPPET_CATEGORIES).default("special_terms"),
  title: z.string().trim().min(1, "title は必須です").max(200),
  body: z.string().max(5000).default(""),
  sortOrder: z.number().int().min(0).max(9999).default(0)
});
export type SnippetSaveInput = z.infer<typeof snippetSaveSchema>;

export interface SharedSnippet {
  id: number; category: string; title: string; body: string; sortOrder: number;
}

export class SnippetError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export interface SnippetsRepository {
  list(): Promise<SharedSnippet[]>;
  save(input: SnippetSaveInput): Promise<{ id: number; mode: "insert" | "update" }>;
  deactivate(id: number): Promise<void>;
}

function mapRow(r: Record<string, unknown>): SharedSnippet {
  return {
    id: Number(r.id), category: String(r.category), title: String(r.title),
    body: String(r.body ?? ""), sortOrder: Number(r.sort_order ?? 0)
  };
}

export class PgSnippetsRepository implements SnippetsRepository {
  constructor(private readonly database: DatabasePool) {}

  async list(): Promise<SharedSnippet[]> {
    try {
      const r = await this.database.query(
        `SELECT id, category, title, body, sort_order FROM text_snippets
          WHERE is_active = TRUE ORDER BY category, sort_order, id`);
      return r.rows.map(mapRow);
    } catch (error) {
      if ((error as { code?: string })?.code === "42P01") return [];   // 表未作成は空縮退（V1 同様）
      throw error;
    }
  }

  async save(input: SnippetSaveInput): Promise<{ id: number; mode: "insert" | "update" }> {
    if (input.id != null) {
      const u = await this.database.query(
        `UPDATE text_snippets SET category = $1, title = $2, body = $3, sort_order = $4, updated_at = now()
          WHERE id = $5 RETURNING id`,
        [input.category, input.title, input.body, input.sortOrder, input.id]);
      if (!u.rows.length) throw new SnippetError("SNIPPET_NOT_FOUND", "スニペットが見つかりません");
      return { id: input.id, mode: "update" };
    }
    const r = await this.database.query(
      `INSERT INTO text_snippets (category, title, body, sort_order) VALUES ($1, $2, $3, $4) RETURNING id`,
      [input.category, input.title, input.body, input.sortOrder]);
    return { id: Number(r.rows[0].id), mode: "insert" };
  }

  async deactivate(id: number): Promise<void> {
    const r = await this.database.query(
      `UPDATE text_snippets SET is_active = FALSE, updated_at = now() WHERE id = $1 AND is_active RETURNING id`,
      [id]);
    if (!r.rows.length) throw new SnippetError("SNIPPET_NOT_FOUND", "スニペットが見つかりません");
  }
}

export class MemorySnippetsRepository implements SnippetsRepository {
  private seq: number;
  constructor(readonly rows: Array<SharedSnippet & { isActive: boolean }> = [], private readonly forbidden = false) {
    this.seq = Math.max(0, ...rows.map((r) => r.id)) + 1;
  }
  private guard() { if (this.forbidden) { const e = new Error("forbidden"); (e as { code?: string }).code = "42501"; throw e; } }
  async list() {
    return this.rows.filter((r) => r.isActive)
      .sort((a, b) => a.category.localeCompare(b.category) || a.sortOrder - b.sortOrder || a.id - b.id)
      .map(({ isActive: _isActive, ...rest }) => rest);
  }
  async save(input: SnippetSaveInput): Promise<{ id: number; mode: "insert" | "update" }> {
    this.guard();
    if (input.id != null) {
      const row = this.rows.find((r) => r.id === input.id);
      if (!row) throw new SnippetError("SNIPPET_NOT_FOUND", "スニペットが見つかりません");
      Object.assign(row, { category: input.category, title: input.title, body: input.body, sortOrder: input.sortOrder });
      return { id: input.id, mode: "update" };
    }
    const id = this.seq++;
    this.rows.push({ id, category: input.category, title: input.title, body: input.body, sortOrder: input.sortOrder, isActive: true });
    return { id, mode: "insert" };
  }
  async deactivate(id: number) {
    this.guard();
    const row = this.rows.find((r) => r.id === id && r.isActive);
    if (!row) throw new SnippetError("SNIPPET_NOT_FOUND", "スニペットが見つかりません");
    row.isActive = false;
  }
}
