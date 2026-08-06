import { z } from "zod";

// 取引先マージ（名寄せ）。source（旧・重複）を target（新・存続）へ寄せる。
// 実行は合言葉 COMMIT_VENDOR_MERGE を要求する（金銭FKを再指定するため厳格化）。
export const VENDOR_MERGE_CONFIRMATION = "COMMIT_VENDOR_MERGE";

export const vendorMergeSchema = z.object({
  targetId: z.coerce.number().int().positive(),
  sourceId: z.coerce.number().int().positive(),
  confirmation: z.string()
}).refine((v) => v.targetId !== v.sourceId, {
  message: "同一の取引先はマージできません", path: ["sourceId"]
}).refine((v) => v.confirmation === VENDOR_MERGE_CONFIRMATION, {
  message: `確認トークン ${VENDOR_MERGE_CONFIRMATION} が必要です`, path: ["confirmation"]
});

export type VendorMergeInput = z.infer<typeof vendorMergeSchema>;
