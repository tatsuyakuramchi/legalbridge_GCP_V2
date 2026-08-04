import { z } from "zod";

const trimmed = z.string().trim();
const nullableText = (max: number) =>
  z.string().max(max).optional().nullable()
    .transform((value) => { const next = (value ?? "").trim(); return next ? next : null; });

// works: work_code UNIQUE NOT NULL, title NOT NULL (shared production schema).
export const workCreateSchema = z.object({
  title: trimmed.min(1, "作品名は必須です").max(1000),
  workCode: trimmed.max(40).optional().transform((v) => (v ? v : undefined)),
  ledgerCode: nullableText(40),
  remarks: nullableText(4000),
  isActive: z.boolean().optional().default(true)
});
export const workUpdateSchema = z.object({
  title: trimmed.min(1).max(1000).optional(),
  workCode: trimmed.min(1).max(40).optional(),
  ledgerCode: nullableText(40).optional(),
  remarks: nullableText(4000).optional(),
  isActive: z.boolean().optional()
}).refine((value) => Object.keys(value).length > 0, {
  message: "更新するフィールドを1つ以上指定してください"
});

export type WorkCreateInput = z.infer<typeof workCreateSchema>;
export type WorkUpdateInput = z.infer<typeof workUpdateSchema>;
