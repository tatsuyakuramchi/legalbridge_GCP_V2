import { z } from "zod";

// 発行文書の void（無効化・破壊的・Phase 10-2）。文書を lifecycle_status='voided' にし、
// 紐づく有効実績（condition_events）を取消して残高を復元する。取り返しがつかないため
// 合言葉 COMMIT_DOCUMENT_VOID を実行時に要求する。理由は任意（監査台帳へ記録）。
export const DOCUMENT_VOID_CONFIRMATION = "COMMIT_DOCUMENT_VOID";

export const documentVoidSchema = z.object({
  confirmation: z.string(),
  reason: z.string().trim().max(500).optional()
}).refine((v) => v.confirmation === DOCUMENT_VOID_CONFIRMATION, {
  message: `確認トークン ${DOCUMENT_VOID_CONFIRMATION} が必要です`, path: ["confirmation"]
});

export type DocumentVoidInput = z.infer<typeof documentVoidSchema>;
