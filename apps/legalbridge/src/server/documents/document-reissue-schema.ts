import { z } from "zod";

// 文書の再発行（破壊的・Phase 10-1b）。既存確定文書を基に新版を採番して発行し、旧版を
// reissued（superseded）へ倒す＋旧版実績を取消（残高の二重計上を防ぐ）。取り返しがつかない
// ため合言葉 COMMIT_DOCUMENT_REISSUE を実行時に要求する。formData 省略時は旧版の内容を複製。
export const DOCUMENT_REISSUE_CONFIRMATION = "COMMIT_DOCUMENT_REISSUE";

export const documentReissueSchema = z.object({
  confirmation: z.string(),
  reason: z.string().trim().max(500).optional(),
  formData: z.record(z.string(), z.unknown()).optional()
}).refine((v) => v.confirmation === DOCUMENT_REISSUE_CONFIRMATION, {
  message: `確認トークン ${DOCUMENT_REISSUE_CONFIRMATION} が必要です`, path: ["confirmation"]
});

export type DocumentReissueInput = z.infer<typeof documentReissueSchema>;
