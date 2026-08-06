import { z } from "zod";

// material_rights_sources（権利ソース）書込みスキーマ。
// 素材(work_materials)がどの契約/作品/権利者から権利を得ているかを表す。
// source_type 例: 'direct_contract'（直接契約）/ 'upstream_license'（上流ライセンス）。

const nullableText = (max: number) =>
  z.string().max(max).optional().nullable()
    .transform((value) => { const next = (value ?? "").trim(); return next ? next : null; });
const nullablePositiveId = z.union([z.coerce.number().int().positive(), z.null()]).optional();
// YYYY-MM-DD or null。
const nullableDate = z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD形式で入力してください"), z.null()]).optional();

export const rightsSourceCreateSchema = z.object({
  materialId: z.coerce.number().int().positive(),
  sourceType: z.string().trim().min(1, "ソース種別は必須です").max(80),
  sourceWorkId: nullablePositiveId,
  rightsHolderVendorId: nullablePositiveId,
  sourceDocumentId: nullablePositiveId,
  sourceContractId: nullablePositiveId,
  sourceRole: nullableText(80),
  isPrimary: z.boolean().optional().default(false),
  validFrom: nullableDate,
  validTo: nullableDate
});

// 更新は材料の付け替えを禁止（material_id は不変。再作成で対応）。
export const rightsSourceUpdateSchema = z.object({
  sourceType: z.string().trim().min(1).max(80).optional(),
  sourceWorkId: nullablePositiveId,
  rightsHolderVendorId: nullablePositiveId,
  sourceDocumentId: nullablePositiveId,
  sourceContractId: nullablePositiveId,
  sourceRole: nullableText(80).optional(),
  isPrimary: z.boolean().optional(),
  validFrom: nullableDate,
  validTo: nullableDate
}).refine((value) => Object.keys(value).length > 0, {
  message: "更新するフィールドを1つ以上指定してください"
});

export type RightsSourceCreateInput = z.infer<typeof rightsSourceCreateSchema>;
export type RightsSourceUpdateInput = z.infer<typeof rightsSourceUpdateSchema>;
