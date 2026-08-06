import type { DatabasePool } from "../db/pool.js";
import type { RightsSourceCreateInput, RightsSourceUpdateInput } from "./rights-source-write-schema.js";

// 権利ソース(material_rights_sources)の書込み。INSERT は 007 で付与済み、
// UPDATE は 017 で付与（DELETEなし）。guarded-write・既定OFF。

export interface SavedRightsSource { id: number; materialId: number; }

export class RightsSourceWriteError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export interface RightsSourceWriteRepository {
  create(input: RightsSourceCreateInput): Promise<SavedRightsSource>;
  update(id: number, input: RightsSourceUpdateInput): Promise<SavedRightsSource>;
}

// スキーマのキー → DB列。materialId は create のみ（更新不可）。
const COLUMNS: Record<string, string> = {
  materialId: "material_id", sourceType: "source_type", sourceWorkId: "source_work_id",
  rightsHolderVendorId: "rights_holder_vendor_id", sourceDocumentId: "source_document_id",
  sourceContractId: "source_contract_id", sourceRole: "source_role", isPrimary: "is_primary",
  validFrom: "valid_from", validTo: "valid_to"
};

export class PgRightsSourceWriteRepository implements RightsSourceWriteRepository {
  constructor(private readonly database: DatabasePool) {}

  async create(input: RightsSourceCreateInput) {
    const columns: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(COLUMNS)) {
      const value = (input as Record<string, unknown>)[key];
      if (value === undefined) continue;
      columns.push(column); values.push(value);
    }
    const placeholders = values.map((_, index) => `$${index + 1}`);
    try {
      const result = await this.database.query(
        `INSERT INTO material_rights_sources (${columns.join(", ")})
         VALUES (${placeholders.join(", ")}) RETURNING id, material_id`,
        values
      );
      return { id: Number(result.rows[0].id), materialId: Number(result.rows[0].material_id) };
    } catch (error) { throw translate(error); }
  }

  async update(id: number, input: RightsSourceUpdateInput) {
    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(COLUMNS)) {
      if (key === "materialId") continue; // 付け替え禁止。
      const value = (input as Record<string, unknown>)[key];
      if (value === undefined) continue;
      values.push(value); assignments.push(`${column} = $${values.length}`);
    }
    values.push(id);
    try {
      const result = await this.database.query(
        `UPDATE material_rights_sources SET ${assignments.join(", ")}
          WHERE id = $${values.length} RETURNING id, material_id`,
        values
      );
      if (!result.rows[0]) throw new RightsSourceWriteError("RIGHTS_SOURCE_NOT_FOUND", "指定した権利ソースが見つかりません");
      return { id: Number(result.rows[0].id), materialId: Number(result.rows[0].material_id) };
    } catch (error) { throw translate(error); }
  }
}

function translate(error: unknown): Error {
  if (error instanceof RightsSourceWriteError) return error;
  const code = (error as { code?: string })?.code;
  if (code === "23503") return new RightsSourceWriteError("RIGHTS_SOURCE_INVALID_REF", "参照先（素材・作品・取引先・文書・契約）が存在しません");
  if (code === "23502") return new RightsSourceWriteError("RIGHTS_SOURCE_REQUIRED", "必須項目が不足しています");
  return error instanceof Error ? error : new Error(String(error));
}

export class MemoryRightsSourceWriteRepository implements RightsSourceWriteRepository {
  private seq = 0;
  readonly sources = new Map<number, Record<string, unknown> & { id: number; materialId: number }>();
  async create(input: RightsSourceCreateInput) {
    const id = ++this.seq;
    this.sources.set(id, { ...input, id, materialId: input.materialId });
    return { id, materialId: input.materialId };
  }
  async update(id: number, input: RightsSourceUpdateInput) {
    const existing = this.sources.get(id);
    if (!existing) throw new RightsSourceWriteError("RIGHTS_SOURCE_NOT_FOUND", "指定した権利ソースが見つかりません");
    Object.assign(existing, input);
    return { id, materialId: existing.materialId };
  }
}
