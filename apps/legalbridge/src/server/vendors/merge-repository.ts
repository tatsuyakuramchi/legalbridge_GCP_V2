import type { DatabasePool } from "../db/pool.js";
import type { VendorMergeInput } from "./merge-schema.js";

// 取引先マージ（名寄せ・Phase 4）。source の全参照を target へ再指定し、
// source を is_active=false で残す（DELETEしない・監査保持）。
// プレビューは既存SELECTのみ（新規GRANT不要）。実行は grant 018 が要る
// 列（condition_lines/material_categories/contracts/contract_works の各vendor列）
// を含む8表を1トランザクションで更新する。

// 取引先を参照する全FK（表・列）。列名はコード内固定（ユーザー入力ではない）。
export const VENDOR_REFERENCES: Array<{ table: string; column: string; label: string }> = [
  { table: "condition_lines", column: "counterparty_vendor_id", label: "条件明細（取引先）" },
  { table: "payments", column: "counterparty_vendor_id", label: "支払（取引先）" },
  { table: "works", column: "rights_holder_vendor_id", label: "作品（権利者）" },
  { table: "work_materials", column: "rights_holder_vendor_id", label: "素材（権利者）" },
  { table: "material_rights_sources", column: "rights_holder_vendor_id", label: "権利ソース（権利者）" },
  { table: "material_categories", column: "rights_holder_vendor_id", label: "素材カテゴリ（権利者）" },
  { table: "contracts", column: "primary_vendor_id", label: "契約（主取引先）" },
  { table: "contract_works", column: "rights_holder_vendor_id", label: "契約-作品（権利者）" }
];

export class VendorMergeError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export interface VendorRef { id: number; vendorName: string | null; vendorCode: string | null; isActive: boolean | null; }
export interface ReferenceCount { table: string; column: string; label: string; count: number | null; }
export interface MergePreview {
  target: VendorRef;
  source: VendorRef;
  references: ReferenceCount[];
  totalReferences: number;
}
export interface MergeResult {
  targetId: number;
  sourceId: number;
  repointed: Array<{ table: string; column: string; count: number }>;
  totalRepointed: number;
  sourceDeactivated: boolean;
}

export interface VendorMergeRepository {
  preview(targetId: number, sourceId: number): Promise<MergePreview>;
  merge(input: VendorMergeInput): Promise<MergeResult>;
}

function toRef(row: Record<string, unknown> | undefined): VendorRef | null {
  if (!row) return null;
  return {
    id: Number(row.id), vendorName: row.vendor_name == null ? null : String(row.vendor_name),
    vendorCode: row.vendor_code == null ? null : String(row.vendor_code),
    isActive: row.is_active == null ? null : Boolean(row.is_active)
  };
}

export class PgVendorMergeRepository implements VendorMergeRepository {
  constructor(private readonly database: DatabasePool) {}

  private async fetchVendor(id: number): Promise<VendorRef | null> {
    const r = await this.database.query(
      `SELECT id, vendor_name, vendor_code, is_active FROM vendors WHERE id = $1`, [id]);
    return toRef(r.rows[0]);
  }

  async preview(targetId: number, sourceId: number): Promise<MergePreview> {
    const [target, source] = await Promise.all([this.fetchVendor(targetId), this.fetchVendor(sourceId)]);
    if (!target) throw new VendorMergeError("VENDOR_MERGE_TARGET_NOT_FOUND", "存続先の取引先が見つかりません");
    if (!source) throw new VendorMergeError("VENDOR_MERGE_SOURCE_NOT_FOUND", "統合元の取引先が見つかりません");
    const references: ReferenceCount[] = await Promise.all(VENDOR_REFERENCES.map(async (ref) => {
      try {
        const r = await this.database.query(
          `SELECT count(*) AS c FROM ${ref.table} WHERE ${ref.column} = $1`, [sourceId]);
        return { table: ref.table, column: ref.column, label: ref.label, count: Number(r.rows[0]?.c ?? 0) };
      } catch (error) {
        // 権限不足・未整備は count 不明（null）として提示。
        const code = (error as { code?: string })?.code;
        if (code === "42501" || code === "42P01" || code === "42703") {
          return { table: ref.table, column: ref.column, label: ref.label, count: null };
        }
        throw error;
      }
    }));
    const totalReferences = references.reduce((sum, r) => sum + (r.count ?? 0), 0);
    return { target, source, references, totalReferences };
  }

  async merge(input: VendorMergeInput): Promise<MergeResult> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const target = await client.query(`SELECT id FROM vendors WHERE id = $1 FOR UPDATE`, [input.targetId]);
      if (!target.rows.length) throw new VendorMergeError("VENDOR_MERGE_TARGET_NOT_FOUND", "存続先の取引先が見つかりません");
      const source = await client.query(`SELECT id FROM vendors WHERE id = $1 FOR UPDATE`, [input.sourceId]);
      if (!source.rows.length) throw new VendorMergeError("VENDOR_MERGE_SOURCE_NOT_FOUND", "統合元の取引先が見つかりません");

      const repointed: Array<{ table: string; column: string; count: number }> = [];
      for (const ref of VENDOR_REFERENCES) {
        const r = await client.query(
          `UPDATE ${ref.table} SET ${ref.column} = $1 WHERE ${ref.column} = $2`,
          [input.targetId, input.sourceId]);
        repointed.push({ table: ref.table, column: ref.column, count: r.rowCount ?? 0 });
      }
      const deactivated = await client.query(
        `UPDATE vendors SET is_active = false WHERE id = $1`, [input.sourceId]);
      await client.query("COMMIT");
      return {
        targetId: input.targetId, sourceId: input.sourceId, repointed,
        totalRepointed: repointed.reduce((sum, r) => sum + r.count, 0),
        sourceDeactivated: (deactivated.rowCount ?? 0) > 0
      };
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof VendorMergeError) throw error;
      const code = (error as { code?: string })?.code;
      if (code === "42501") throw new VendorMergeError("VENDOR_MERGE_FORBIDDEN_DB", "マージに必要なUPDATE権限（grant 018）が未付与です");
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      client.release();
    }
  }
}

// テスト・DB非依存起動用。プリセットの取引先と参照件数で振る舞う。
export class MemoryVendorMergeRepository implements VendorMergeRepository {
  constructor(
    readonly vendors = new Map<number, VendorRef>(),
    private readonly refCounts = new Map<number, number>() // sourceId -> total refs（テスト簡易）
  ) {}

  async preview(targetId: number, sourceId: number): Promise<MergePreview> {
    const target = this.vendors.get(targetId);
    const source = this.vendors.get(sourceId);
    if (!target) throw new VendorMergeError("VENDOR_MERGE_TARGET_NOT_FOUND", "存続先の取引先が見つかりません");
    if (!source) throw new VendorMergeError("VENDOR_MERGE_SOURCE_NOT_FOUND", "統合元の取引先が見つかりません");
    const total = this.refCounts.get(sourceId) ?? 0;
    const references: ReferenceCount[] = VENDOR_REFERENCES.map((ref, i) => ({
      table: ref.table, column: ref.column, label: ref.label, count: i === 0 ? total : 0
    }));
    return { target, source, references, totalReferences: total };
  }

  async merge(input: VendorMergeInput): Promise<MergeResult> {
    const target = this.vendors.get(input.targetId);
    const source = this.vendors.get(input.sourceId);
    if (!target) throw new VendorMergeError("VENDOR_MERGE_TARGET_NOT_FOUND", "存続先の取引先が見つかりません");
    if (!source) throw new VendorMergeError("VENDOR_MERGE_SOURCE_NOT_FOUND", "統合元の取引先が見つかりません");
    const total = this.refCounts.get(input.sourceId) ?? 0;
    this.vendors.set(input.sourceId, { ...source, isActive: false });
    return {
      targetId: input.targetId, sourceId: input.sourceId,
      repointed: VENDOR_REFERENCES.map((ref, i) => ({ table: ref.table, column: ref.column, count: i === 0 ? total : 0 })),
      totalRepointed: total, sourceDeactivated: true
    };
  }
}
