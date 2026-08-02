import { z } from "zod";

// Aligned with production schema (V1 migrations 0102 / 0126):
//   matters.status                    open / in_progress / closed / archived
//   matters.lifecycle_stage CHECK     intake .. cancelled  (NULL = 未設定)
//   matter_tasks.status CHECK         open / in_progress / done / cancelled
export const MATTER_STATUSES = ["open", "in_progress", "closed", "archived"] as const;
export const LIFECYCLE_STAGES = [
  "intake", "triage", "drafting", "internal_review", "counterparty_review",
  "signing", "performance", "inspection", "invoicing_payment",
  "completion_check", "completed", "cancelled"
] as const;
export const TASK_STATUSES = ["open", "in_progress", "done", "cancelled"] as const;

const trimmed = z.string().trim();
const optionalText = (max: number) =>
  trimmed.max(max).optional().transform((value) => (value ? value : undefined));
// Accept "" from form fields as "clear / not set".
const nullableText = (max: number) =>
  z.string().max(max).optional().nullable()
    .transform((value) => {
      const next = (value ?? "").trim();
      return next ? next : null;
    });
const optionalStaffId = z.coerce.number().int().positive().optional().nullable()
  .transform((value) => (value ? value : null));
const optionalDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD形式で指定してください")
  .optional().nullable().transform((value) => (value ? value : null));
const optionalTimestamp = z.string().trim().datetime({ offset: true })
  .optional().nullable().transform((value) => (value ? value : null));

export const matterCreateSchema = z.object({
  title: trimmed.min(1, "案件名は必須です").max(500),
  status: z.enum(MATTER_STATUSES).default("open"),
  lifecycleStage: z.enum(LIFECYCLE_STAGES).optional().nullable()
    .transform((value) => value ?? null),
  ownerStaffId: optionalStaffId,
  counterparty: nullableText(1000),
  primaryIssueKey: z.string().trim().max(50).optional().nullable()
    .transform((value) => {
      const next = (value ?? "").trim();
      return next ? next : null;
    }),
  targetDueDate: optionalDate,
  blockedReason: nullableText(2000),
  remarks: nullableText(4000),
  matterCode: optionalText(40)
});

// Update is a partial patch; only provided keys change.
export const matterUpdateSchema = z.object({
  title: trimmed.min(1).max(500).optional(),
  status: z.enum(MATTER_STATUSES).optional(),
  lifecycleStage: z.enum(LIFECYCLE_STAGES).nullable().optional(),
  ownerStaffId: z.coerce.number().int().positive().nullable().optional(),
  counterparty: nullableText(1000).optional(),
  primaryIssueKey: z.string().trim().max(50).nullable().optional()
    .transform((value) => {
      if (value === undefined) return undefined;
      const next = (value ?? "").trim();
      return next ? next : null;
    }),
  targetDueDate: optionalDate.optional(),
  blockedReason: nullableText(2000).optional(),
  remarks: nullableText(4000).optional(),
  completionReason: nullableText(2000).optional()
}).refine((value) => Object.keys(value).length > 0, {
  message: "更新するフィールドを1つ以上指定してください"
});

export const taskCreateSchema = z.object({
  title: trimmed.min(1, "タスク名は必須です").max(500),
  taskType: optionalText(40),
  description: nullableText(4000),
  assigneeStaffId: optionalStaffId,
  dueAt: optionalTimestamp,
  status: z.enum(TASK_STATUSES).default("open"),
  blockedReason: nullableText(2000),
  isPrimary: z.boolean().default(false)
});

export const taskUpdateSchema = z.object({
  title: trimmed.min(1).max(500).optional(),
  taskType: nullableText(40).optional(),
  description: nullableText(4000).optional(),
  assigneeStaffId: z.coerce.number().int().positive().nullable().optional(),
  dueAt: optionalTimestamp.optional(),
  status: z.enum(TASK_STATUSES).optional(),
  blockedReason: nullableText(2000).optional(),
  isPrimary: z.boolean().optional()
}).refine((value) => Object.keys(value).length > 0, {
  message: "更新するフィールドを1つ以上指定してください"
});

export type MatterCreateInput = z.infer<typeof matterCreateSchema>;
export type MatterUpdateInput = z.infer<typeof matterUpdateSchema>;
export type TaskCreateInput = z.infer<typeof taskCreateSchema>;
export type TaskUpdateInput = z.infer<typeof taskUpdateSchema>;
