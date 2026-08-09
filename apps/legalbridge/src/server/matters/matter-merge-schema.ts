import { z } from "zod";

// 案件マージ（名寄せ）。source（重複）を target（存続）へ寄せ、source はアーカイブする
// （DELETE しない・監査保持）。破壊的なので合言葉 COMMIT_MATTER_MERGE を要求する。
export const MATTER_MERGE_CONFIRMATION = "COMMIT_MATTER_MERGE";

export const matterMergeSchema = z.object({
  targetId: z.coerce.number().int().positive(),
  sourceId: z.coerce.number().int().positive(),
  confirmation: z.string()
}).refine((v) => v.targetId !== v.sourceId, {
  message: "同一の案件はマージできません", path: ["sourceId"]
}).refine((v) => v.confirmation === MATTER_MERGE_CONFIRMATION, {
  message: `確認トークン ${MATTER_MERGE_CONFIRMATION} が必要です`, path: ["confirmation"]
});

export type MatterMergeInput = z.infer<typeof matterMergeSchema>;
