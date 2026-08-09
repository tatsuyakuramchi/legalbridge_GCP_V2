import { z } from "zod";

// 案件削除（破壊的）。FK 参照アクションで課題リンク・タスクを連鎖削除し、文書・送信履歴は
// 解除（SET NULL）する。取り返しがつかないため合言葉 COMMIT_MATTER_DELETE を要求する。
// タスク単体削除（DELETE /matters/:id/tasks/:taskId）は単一行のため合言葉不要（代表タスクは拒否）。
export const MATTER_DELETE_CONFIRMATION = "COMMIT_MATTER_DELETE";

export const matterDeleteSchema = z.object({
  confirmation: z.string()
}).refine((v) => v.confirmation === MATTER_DELETE_CONFIRMATION, {
  message: `確認トークン ${MATTER_DELETE_CONFIRMATION} が必要です`, path: ["confirmation"]
});

export type MatterDeleteInput = z.infer<typeof matterDeleteSchema>;
