import { z } from "zod";
import { csvBool, csvOptionalId } from "../import/bulk.js";

// 原作マテリアル(work_materials)の登録・編集スキーマ。
// マテリアルは必ず作品(works)に属する（work_id FK）。素材区分(materialType)は
// material_categories.genre として扱い、作品内で区分ごとにカテゴリを確保する。
// enum 値は契約取込ウィザード(intake.ts)と一致させ CHECK 制約違反を避ける。

const materialTypeEnum = z.enum([
  "game_design",
  "illustration",
  "scenario",
  "manuscript",
  "other"
]);
const materialRoleEnum = z.enum(["core_logic", "sub_component"]);
const acquisitionTypeEnum = z.enum(["license", "buyout_commission", "in_house"]);
const rightsTypeEnum = z.enum(["owned", "license"]);

export const materialCreateSchema = z.object({
  workId: z.number().int().positive(),
  materialName: z.string().trim().min(1, "素材名は必須です").max(300),
  materialType: materialTypeEnum,
  materialRole: materialRoleEnum,
  acquisitionType: acquisitionTypeEnum,
  rightsType: rightsTypeEnum.optional().default("license"),
  rightsHolderVendorId: z.number().int().positive().optional(),
  rightsHolderLabel: z.string().trim().max(300).optional(),
  territory: z.string().trim().max(500).optional(),
  language: z.string().trim().max(500).optional(),
  isDefault: z.boolean().optional().default(false),
  isRoyaltyBearing: z.boolean().optional().default(false),
  remarks: z.string().trim().max(2000).optional()
});
export type MaterialCreateInput = z.infer<typeof materialCreateSchema>;

// CSV一括取込用（文字列を数値/真偽へ寄せる）。create と同じFK・enum制約。
export const materialImportRowSchema = z.object({
  workId: z.coerce.number().int().positive(),
  materialName: z.string().trim().min(1, "素材名は必須です").max(300),
  materialType: materialTypeEnum,
  materialRole: materialRoleEnum,
  acquisitionType: acquisitionTypeEnum,
  rightsType: rightsTypeEnum.optional().default("license"),
  rightsHolderVendorId: csvOptionalId,
  rightsHolderLabel: z.string().trim().max(300).optional(),
  territory: z.string().trim().max(500).optional(),
  language: z.string().trim().max(500).optional(),
  isDefault: csvBool.optional().default(false),
  isRoyaltyBearing: csvBool.optional().default(false),
  remarks: z.string().trim().max(2000).optional()
});
export type MaterialImportRowInput = z.infer<typeof materialImportRowSchema>;

// 更新は素材区分(materialType)・所属作品(workId)を変更しない。
// これらはカテゴリと素材コードを規定するため、付け替えは新規作成で行う。
export const materialUpdateSchema = z.object({
  materialName: z.string().trim().min(1).max(300).optional(),
  materialRole: materialRoleEnum.optional(),
  acquisitionType: acquisitionTypeEnum.optional(),
  rightsType: rightsTypeEnum.optional(),
  rightsHolderVendorId: z.number().int().positive().nullable().optional(),
  rightsHolderLabel: z.string().trim().max(300).nullable().optional(),
  territory: z.string().trim().max(500).nullable().optional(),
  language: z.string().trim().max(500).nullable().optional(),
  isDefault: z.boolean().optional(),
  isRoyaltyBearing: z.boolean().optional(),
  remarks: z.string().trim().max(2000).nullable().optional()
}).refine((value) => Object.keys(value).length > 0, {
  message: "更新する項目がありません"
});
export type MaterialUpdateInput = z.infer<typeof materialUpdateSchema>;
