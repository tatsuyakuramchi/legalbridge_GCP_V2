import { z } from "zod";

// スキーマ駆動の一括取込ヘルパ（Phase 4）。行ごとに検証→登録し、成功/失敗を
// 独立に集計する（1行の失敗が他行を止めない）。既存のエンティティ別取込
// （works/vendors/staff）と同じ応答形状を共有化したもの。

export interface BulkImportReport {
  insertedCount: number;
  failedCount: number;
  inserted: Array<Record<string, unknown> & { index: number }>;
  failed: Array<{ index: number; error: string }>;
}

export async function bulkImport<T, R extends object>(
  rows: unknown[],
  schema: z.ZodType<T>,
  create: (input: T) => Promise<R>
): Promise<BulkImportReport> {
  const inserted: Array<Record<string, unknown> & { index: number }> = [];
  const failed: Array<{ index: number; error: string }> = [];
  for (let index = 0; index < rows.length; index += 1) {
    const parsed = schema.safeParse(rows[index]);
    if (!parsed.success) {
      failed.push({ index, error: parsed.error.issues.map((i) => i.message).join(" / ") });
      continue;
    }
    try {
      const row = await create(parsed.data);
      inserted.push({ index, ...row });
    } catch (error) {
      failed.push({ index, error: error instanceof Error ? error.message : "登録に失敗しました" });
    }
  }
  return { insertedCount: inserted.length, failedCount: failed.length, inserted, failed };
}

// CSV由来の値（文字列）を各型へ寄せる共通プリミティブ。
export const csvBool = z.preprocess((value) => {
  if (typeof value === "boolean") return value;
  const s = String(value ?? "").trim().toLowerCase();
  if (["true", "1", "yes", "y", "はい", "対象", "○", "o"].includes(s)) return true;
  if (["false", "0", "no", "n", "いいえ", "対象外", "×", "x", ""].includes(s)) return false;
  return value;
}, z.boolean());

// 空文字を undefined 化してから任意の正整数へ。
export const csvOptionalId = z.preprocess(
  (value) => (String(value ?? "").trim() === "" ? undefined : value),
  z.coerce.number().int().positive().optional()
);
