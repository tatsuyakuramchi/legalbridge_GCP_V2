import { z } from "zod";

// 承認ルート（Phase 11-2）。部門ごとの承認者/押印担当/責任者の Slack ID・部署チャンネル・有効フラグ。
// department_workflow_rules（department UNIQUE）を upsert する。Slack ID は U/W…、チャンネルは C… だが
// 空も許容する（未設定の役割がありうる）。緩めに検証し保存の柔軟性を確保する。

const slackId = z.string().trim().max(50)
  .refine((v) => v === "" || /^[UWC][A-Z0-9]{5,}$/.test(v), { message: "Slack ID は U/W/C で始まる形式です（空可）" })
  .optional().transform((v) => (v && v.trim() ? v.trim() : null));

export const workflowRuleSchema = z.object({
  department: z.string().trim().min(1, "部門は必須です").max(100),
  approverSlackId: slackId,
  stampOperatorSlackId: slackId,
  managerSlackId: slackId,
  slackChannelId: slackId,
  isActive: z.boolean().optional().default(true)
});

export type WorkflowRuleInput = z.infer<typeof workflowRuleSchema>;
