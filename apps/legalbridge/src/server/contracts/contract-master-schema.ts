import { z } from "zod";

// 契約マスタの更新・状態変更（Phase 11-4）。登録(INSERT)は contract-intake が担うため、ここでは
// 既存 contracts 行の中核フィールド更新とライフサイクル状態変更のみ。全列は触らない（grant 038）。

// ライフサイクル状態（V1 の lifecycle_stage 準拠）。
export const LIFECYCLE_STAGES = [
  "requested", "drafting", "reviewing", "awaiting_signature", "executed",
  "on_hold", "cancelled", "expired", "terminated"
] as const;
export type LifecycleStage = typeof LIFECYCLE_STAGES[number];

// 省略されたキーは省略のまま残す（部分更新のため）。transform は optional の undefined でも走るので、
// undefined はそのまま返して出力にキーを増やさない（空文字/空白は null に正規化）。
const dateOrNull = z.string().trim().max(10).optional().nullable()
  .transform((v) => (v === undefined ? undefined : (v && v.trim() ? v.trim() : null)));

export const contractUpdateSchema = z.object({
  contractTitle: z.string().trim().max(500).optional().nullable()
    .transform((v) => (v === undefined ? undefined : (v && v.trim() ? v.trim() : null))),
  effectiveDate: dateOrNull,
  expirationDate: dateOrNull,
  autoRenewal: z.boolean().optional(),
  renewalNoticeMonths: z.number().int().min(0).max(120).optional().nullable(),
  alertLeadMonths: z.number().int().min(0).max(120).optional().nullable(),
  reviewDueDate: dateOrNull
}).refine((v) => Object.keys(v).length > 0, { message: "更新する項目がありません" });

export const contractStatusSchema = z.object({
  lifecycleStage: z.enum(LIFECYCLE_STAGES)
});

export type ContractUpdateInput = z.infer<typeof contractUpdateSchema>;
export type ContractStatusInput = z.infer<typeof contractStatusSchema>;
