import { inTransaction, str, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { SNIPPET_CATEGORIES, type SnippetCategory } from "./categories.js";
export { SNIPPET_CATEGORIES, SNIPPET_CATEGORY_LABEL } from "./categories.js";

/**
 * 定型文。文書の長文欄へ貼るための、全社で共有する文面。
 *
 * 許諾範囲・特約・仕様のような欄は、毎回ゼロから書くものではなく、決めた
 * 言い回しを選んで貼るもの。V2 は V1 の text_snippets を共有の定型文集として
 * 持っていた（Phase 16-1）。V3 は public を一切触れないので、v3 に写した表を
 * 読み書きする（A-021）。
 *
 * 消すのは論理削除だけ。書類に貼った文面の出どころが消えると、あとから
 * 「どの版を貼ったのか」を辿れなくなる。
 */

export interface Snippet {
  id: number;
  category: string;
  title: string;
  body: string;
  sortOrder: number;
}

export interface SnippetInput {
  category?: string;
  title: string;
  body?: string;
  sortOrder?: number;
}

const isCategory = (value: string): value is SnippetCategory =>
  (SNIPPET_CATEGORIES as readonly string[]).includes(value);

/** 入れる前に形を確かめる。区分は表の CHECK と同じ4つ。 */
export function parseSnippet(input: SnippetInput): Required<SnippetInput> {
  const title = str(input.title)?.trim() ?? "";
  if (!title) throw new DomainError("VALIDATION", "定型文の名前は空にできません");
  if (title.length > 200) throw new DomainError("VALIDATION", "定型文の名前が長すぎます（200字まで）");
  const body = String(input.body ?? "");
  if (body.length > 5000) throw new DomainError("VALIDATION", "定型文の本文が長すぎます（5000字まで）");
  const category = String(input.category ?? "special_terms");
  if (!isCategory(category)) {
    throw new DomainError("VALIDATION", `区分 ${category} は使えません`);
  }
  const sortOrder = Number(input.sortOrder ?? 0);
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 9999) {
    throw new DomainError("VALIDATION", "表示順は 0〜9999 の整数で入れてください");
  }
  return { category, title, body, sortOrder };
}

const mapRow = (row: Record<string, any>): Snippet => ({
  id: Number(row.id),
  category: String(row.category),
  title: String(row.title),
  body: String(row.body ?? ""),
  sortOrder: Number(row.sort_order ?? 0)
});

export class SnippetService {
  constructor(private readonly database: Transactable) {}

  /** 使える文面。区分・表示順の順に並べる（画面はこの順で区分ごとに束ねる）。 */
  async list(): Promise<Snippet[]> {
    try {
      const r = await this.database.query(
        `SELECT id, category, title, body, sort_order FROM text_snippets
          WHERE is_active
          ORDER BY array_position($1::text[], category), sort_order, id`,
        [SNIPPET_CATEGORIES as unknown as string[]]);
      return r.rows.map(mapRow);
    } catch (error) { throw translate(error); }
  }

  async create(input: SnippetInput, actor: string): Promise<Snippet> {
    const value = parseSnippet(input);
    try {
      return await inTransaction(this.database, async (client) => {
        const r = await client.query(
          `INSERT INTO text_snippets (category, title, body, sort_order)
           VALUES ($1, $2, $3, $4)
           RETURNING id, category, title, body, sort_order`,
          [value.category, value.title, value.body, value.sortOrder]);
        const row = mapRow(r.rows[0] as Record<string, any>);
        await recordAudit(client, {
          actor, action: "snippet.create", targetType: "text_snippet", targetId: row.id,
          detail: { category: row.category, title: row.title }
        });
        return row;
      });
    } catch (error) { throw translate(error); }
  }

  async update(id: number, input: SnippetInput, actor: string): Promise<Snippet> {
    const value = parseSnippet(input);
    try {
      return await inTransaction(this.database, async (client) => {
        const r = await client.query(
          `UPDATE text_snippets
              SET category = $2, title = $3, body = $4, sort_order = $5, updated_at = now()
            WHERE id = $1 AND is_active
            RETURNING id, category, title, body, sort_order`,
          [id, value.category, value.title, value.body, value.sortOrder]);
        const row = r.rows[0] as Record<string, any> | undefined;
        if (!row) throw new DomainError("NOT_FOUND", `定型文 ${id} が見つかりません`);
        await recordAudit(client, {
          actor, action: "snippet.update", targetType: "text_snippet", targetId: id,
          detail: { category: value.category, title: value.title }
        });
        return mapRow(row);
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 一覧から外す。行は残す（DELETE の権限も持たせていない）。
   * 同じ名前で作り直せるように、名前に一意の制約は置いていない。
   */
  async deactivate(id: number, actor: string): Promise<{ id: number }> {
    try {
      return await inTransaction(this.database, async (client) => {
        const r = await client.query(
          `UPDATE text_snippets SET is_active = false, updated_at = now()
            WHERE id = $1 AND is_active RETURNING title`,
          [id]);
        const row = r.rows[0] as Record<string, any> | undefined;
        if (!row) throw new DomainError("NOT_FOUND", `使われている定型文 ${id} が見つかりません`);
        await recordAudit(client, {
          actor, action: "snippet.deactivate", targetType: "text_snippet", targetId: id,
          detail: { title: String(row.title) }
        });
        return { id };
      });
    } catch (error) { throw translate(error); }
  }
}
