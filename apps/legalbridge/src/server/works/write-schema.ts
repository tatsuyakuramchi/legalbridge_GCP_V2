import { z } from "zod";

const trimmed = z.string().trim();
const nullableText = (max: number) =>
  z.string().max(max).optional().nullable()
    .transform((value) => { const next = (value ?? "").trim(); return next ? next : null; });

// 作品種別（kind）：ライセンスイン / 自社。派生種別は自由記述（licensed_derivative 等）。
const workKind = z.enum(["licensed_in", "own"]);
// 正の整数 or null（親クリア・権利者クリア）。空/未指定は undefined（無変更）。
const nullablePositiveId = z.union([z.coerce.number().int().positive(), z.null()]).optional();

// works: work_code UNIQUE NOT NULL, title NOT NULL (shared production schema).
// Phase 2 で系譜(parent_work_id)・種別(kind/derivation_type/is_original)・
// 権利者(rights_holder_vendor_id)・作者/出版社 の編集列を追加（grant 012 の全表UPDATEで許容）。
export const workCreateSchema = z.object({
  title: trimmed.min(1, "作品名は必須です").max(1000),
  workCode: trimmed.max(40).optional().transform((v) => (v ? v : undefined)),
  titleKana: nullableText(1000),
  workType: nullableText(80),
  kind: workKind.optional(),
  derivationType: nullableText(80),
  isOriginal: z.boolean().optional(),
  parentWorkId: nullablePositiveId,
  rightsHolderVendorId: nullablePositiveId,
  creatorName: nullableText(500),
  publisherName: nullableText(500),
  ledgerCode: nullableText(40),
  remarks: nullableText(4000),
  isActive: z.boolean().optional().default(true)
});
export const workUpdateSchema = z.object({
  title: trimmed.min(1).max(1000).optional(),
  workCode: trimmed.min(1).max(40).optional(),
  titleKana: nullableText(1000).optional(),
  workType: nullableText(80).optional(),
  kind: workKind.optional(),
  derivationType: nullableText(80).optional(),
  isOriginal: z.boolean().optional(),
  parentWorkId: nullablePositiveId,
  rightsHolderVendorId: nullablePositiveId,
  creatorName: nullableText(500).optional(),
  publisherName: nullableText(500).optional(),
  ledgerCode: nullableText(40).optional(),
  remarks: nullableText(4000).optional(),
  isActive: z.boolean().optional()
}).refine((value) => Object.keys(value).length > 0, {
  message: "更新するフィールドを1つ以上指定してください"
});

// work_relations（派生グラフ・系譜の第2真実源）追加。007でINSERT付与済。
// relation_type は現状 'derived_from' のみ。自己参照は不可。
export const workRelationCreateSchema = z.object({
  childWorkId: z.coerce.number().int().positive(),
  parentWorkId: z.coerce.number().int().positive(),
  relationType: z.string().trim().min(1).max(40).optional().default("derived_from")
}).refine((v) => v.childWorkId !== v.parentWorkId, {
  message: "作品を自身の派生元にできません", path: ["parentWorkId"]
});

export type WorkCreateInput = z.infer<typeof workCreateSchema>;
export type WorkUpdateInput = z.infer<typeof workUpdateSchema>;
export type WorkRelationCreateInput = z.infer<typeof workRelationCreateSchema>;
