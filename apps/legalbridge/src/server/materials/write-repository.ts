import type { DatabasePool } from "../db/pool.js";
import type { MaterialCreateInput, MaterialUpdateInput } from "./write-schema.js";

export interface SavedMaterial { id: number; materialCode: string | null; workId: number; }
export interface MaterialRecord {
  id: number; workId: number; workCode: string | null; workTitle: string | null;
  materialCode: string | null;
  materialName: string | null; materialType: string | null; materialRole: string | null;
  acquisitionType: string | null; rightsType: string | null;
  rightsHolderVendorId: number | null; rightsHolderLabel: string | null;
  territory: string | null; language: string | null;
  isDefault: boolean; isRoyaltyBearing: boolean; remarks: string | null;
}
export interface WorkOption { id: number; workCode: string | null; title: string; }

export class MaterialWriteError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export interface MaterialWriteRepository {
  create(input: MaterialCreateInput): Promise<SavedMaterial>;
  update(id: number, input: MaterialUpdateInput): Promise<SavedMaterial>;
  find(id: number): Promise<MaterialRecord | null>;
  listWorks(query: string, limit?: number): Promise<WorkOption[]>;
}

// 更新可能な列（作品・素材区分・採番列は対象外）。
const UPDATE_COLUMNS: Record<string, string> = {
  materialName: "material_name", materialRole: "material_role",
  acquisitionType: "acquisition_type", rightsType: "rights_type",
  rightsHolderVendorId: "rights_holder_vendor_id", rightsHolderLabel: "rights_holder_label",
  territory: "territory", language: "language",
  isDefault: "is_default", isRoyaltyBearing: "is_royalty_bearing", remarks: "remarks"
};

export class PgMaterialWriteRepository implements MaterialWriteRepository {
  constructor(private readonly database: DatabasePool) {}

  async create(input: MaterialCreateInput) {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const work = await client.query(
        "SELECT id, work_code FROM works WHERE id = $1", [input.workId]);
      if (!work.rows[0]) {
        throw new MaterialWriteError("MATERIAL_WORK_NOT_FOUND", "指定した作品が見つかりません");
      }
      const workCode: string | null = work.rows[0].work_code ?? null;

      // 作品×素材区分ごとにカテゴリを確保する（契約取込と同じロジック）。
      await client.query(
        `INSERT INTO material_categories (
           work_id, genre, name, rights_holder_vendor_id,
           rights_holder_label, sort_order, is_active
         ) VALUES ($1, $2, $3, $4, $5, 0, true)
         ON CONFLICT (work_id, genre) DO NOTHING`,
        [input.workId, input.materialType, input.materialType,
          input.rightsHolderVendorId ?? null, input.rightsHolderLabel ?? null]);
      const category = await client.query(
        "SELECT id FROM material_categories WHERE work_id = $1 AND genre = $2",
        [input.workId, input.materialType]);
      const categoryId = Number(category.rows[0].id);

      const numbered = await client.query(
        `SELECT COALESCE(MAX(material_no), 0) + 1 AS material_no
           FROM work_materials WHERE work_id = $1`, [input.workId]);
      const materialNo = Number(numbered.rows[0].material_no);
      const materialCode = `${workCode ?? `W${input.workId}`}-${String(materialNo).padStart(3, "0")}`;

      const inserted = await client.query(
        `INSERT INTO work_materials (
           work_id, material_name, material_type, rights_type,
           rights_holder_vendor_id, is_royalty_bearing, remarks,
           rights_holder_label, material_no, material_code, is_default,
           acquisition_type, material_role, category_id, territory, language
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
         ) RETURNING id, work_id, material_code`,
        [input.workId, input.materialName, input.materialType, input.rightsType,
          input.rightsHolderVendorId ?? null, input.isRoyaltyBearing, input.remarks ?? null,
          input.rightsHolderLabel ?? null, materialNo, materialCode, input.isDefault,
          input.acquisitionType, input.materialRole, categoryId,
          input.territory ?? null, input.language ?? null]);
      await client.query("COMMIT");
      return {
        id: Number(inserted.rows[0].id),
        workId: Number(inserted.rows[0].work_id),
        materialCode: inserted.rows[0].material_code ?? null
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw translate(error);
    } finally {
      client.release();
    }
  }

  async update(id: number, input: MaterialUpdateInput) {
    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(UPDATE_COLUMNS)) {
      const value = (input as Record<string, unknown>)[key];
      if (value === undefined) continue;
      values.push(value); assignments.push(`${column} = $${values.length}`);
    }
    values.push(id);
    try {
      const result = await this.database.query(
        `UPDATE work_materials SET ${assignments.join(", ")} WHERE id = $${values.length}
         RETURNING id, work_id, material_code`, values);
      if (!result.rows[0]) throw new MaterialWriteError("MATERIAL_NOT_FOUND", "指定した素材が見つかりません");
      return {
        id: Number(result.rows[0].id),
        workId: Number(result.rows[0].work_id),
        materialCode: result.rows[0].material_code ?? null
      };
    } catch (error) { throw translate(error); }
  }

  async find(id: number) {
    const result = await this.database.query(
      `SELECT wm.id, wm.work_id, wm.material_code, wm.material_name, wm.material_type, wm.material_role,
              wm.acquisition_type, wm.rights_type, wm.rights_holder_vendor_id,
              wm.rights_holder_label, wm.territory, wm.language,
              wm.is_default, wm.is_royalty_bearing, wm.remarks,
              w.work_code, w.title AS work_title
         FROM work_materials wm
         JOIN works w ON w.id = wm.work_id
        WHERE wm.id = $1`, [id]);
    if (!result.rows[0]) return null;
    const row = result.rows[0];
    return {
      id: Number(row.id), workId: Number(row.work_id),
      workCode: row.work_code ?? null, workTitle: row.work_title ?? null,
      materialCode: row.material_code ?? null,
      materialName: row.material_name ?? null, materialType: row.material_type ?? null,
      materialRole: row.material_role ?? null, acquisitionType: row.acquisition_type ?? null,
      rightsType: row.rights_type ?? null,
      rightsHolderVendorId: row.rights_holder_vendor_id === null ? null : Number(row.rights_holder_vendor_id),
      rightsHolderLabel: row.rights_holder_label ?? null,
      territory: row.territory ?? null, language: row.language ?? null,
      isDefault: Boolean(row.is_default), isRoyaltyBearing: Boolean(row.is_royalty_bearing),
      remarks: row.remarks ?? null
    };
  }

  async listWorks(query: string, limit = 20) {
    const keyword = `%${query.trim()}%`;
    const bounded = Math.min(Math.max(limit, 1), 50);
    const result = await this.database.query(
      `SELECT id, work_code, title FROM works
        WHERE is_active = TRUE AND ($1 = '%%' OR title ILIKE $1 OR work_code ILIKE $1)
        ORDER BY title LIMIT $2`, [keyword, bounded]);
    return result.rows.map((row) => ({
      id: Number(row.id), workCode: row.work_code ?? null, title: String(row.title ?? "")
    }));
  }
}

function translate(error: unknown): Error {
  if (error instanceof MaterialWriteError) return error;
  const code = (error as { code?: string })?.code;
  if (code === "23505") return new MaterialWriteError("MATERIAL_CONFLICT", "素材コードが既に存在します");
  if (code === "23503") return new MaterialWriteError("MATERIAL_WORK_NOT_FOUND", "参照する作品または取引先が存在しません");
  if (code === "23502") return new MaterialWriteError("MATERIAL_REQUIRED", "必須項目が不足しています");
  return error instanceof Error ? error : new Error(String(error));
}

export class MemoryMaterialWriteRepository implements MaterialWriteRepository {
  private seq = 0;
  readonly materials = new Map<number, MaterialRecord>();
  readonly works = new Map<number, WorkOption>([
    [1, { id: 1, workCode: "WRK-00001", title: "テスト作品" }]
  ]);
  private noByWork = new Map<number, number>();

  async create(input: MaterialCreateInput) {
    const work = this.works.get(input.workId);
    if (!work) throw new MaterialWriteError("MATERIAL_WORK_NOT_FOUND", "指定した作品が見つかりません");
    const id = ++this.seq;
    const nextNo = (this.noByWork.get(input.workId) ?? 0) + 1;
    this.noByWork.set(input.workId, nextNo);
    const materialCode = `${work.workCode ?? `W${input.workId}`}-${String(nextNo).padStart(3, "0")}`;
    this.materials.set(id, {
      id, workId: input.workId, workCode: work.workCode, workTitle: work.title,
      materialCode,
      materialName: input.materialName, materialType: input.materialType,
      materialRole: input.materialRole, acquisitionType: input.acquisitionType,
      rightsType: input.rightsType, rightsHolderVendorId: input.rightsHolderVendorId ?? null,
      rightsHolderLabel: input.rightsHolderLabel ?? null,
      territory: input.territory ?? null, language: input.language ?? null,
      isDefault: input.isDefault, isRoyaltyBearing: input.isRoyaltyBearing,
      remarks: input.remarks ?? null
    });
    return { id, workId: input.workId, materialCode };
  }

  async update(id: number, input: MaterialUpdateInput) {
    const existing = this.materials.get(id);
    if (!existing) throw new MaterialWriteError("MATERIAL_NOT_FOUND", "指定した素材が見つかりません");
    Object.assign(existing, input);
    return { id, workId: existing.workId, materialCode: existing.materialCode ?? null };
  }

  async find(id: number) { return this.materials.get(id) ?? null; }

  async listWorks(query: string) {
    const keyword = query.trim().toLowerCase();
    return [...this.works.values()].filter((work) =>
      !keyword || work.title.toLowerCase().includes(keyword) ||
      (work.workCode ?? "").toLowerCase().includes(keyword));
  }
}
