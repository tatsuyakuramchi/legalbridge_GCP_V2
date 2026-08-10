import { z } from "zod";

// Aligned with the shared production vendors table (V1 schema). Only widely
// present, low-risk columns are writable here; bank/withholding details stay
// out of scope for this slice.
const trimmed = z.string().trim();
const nullableText = (max: number) =>
  z.string().max(max).optional().nullable()
    .transform((value) => {
      const next = (value ?? "").trim();
      return next ? next : null;
    });

export const vendorCreateSchema = z.object({
  vendorName: trimmed.min(1, "取引先名は必須です").max(255),
  vendorCode: trimmed.max(50).optional().transform((v) => (v ? v : undefined)),
  tradeName: nullableText(255),
  penName: nullableText(255),
  entityType: nullableText(50),
  email: nullableText(255),
  phone: nullableText(50),
  contactName: nullableText(100),
  contactDepartment: nullableText(100),
  address: nullableText(1000),
  invoiceRegistrationNumber: nullableText(50),
  isInvoiceIssuer: z.boolean().optional().default(false),
  withholdingEnabled: z.boolean().optional().default(false),
  isActive: z.boolean().optional().default(true)
});

export const vendorUpdateSchema = z.object({
  vendorName: trimmed.min(1).max(255).optional(),
  vendorCode: trimmed.min(1).max(50).optional(),
  tradeName: nullableText(255).optional(),
  penName: nullableText(255).optional(),
  entityType: nullableText(50).optional(),
  email: nullableText(255).optional(),
  phone: nullableText(50).optional(),
  contactName: nullableText(100).optional(),
  contactDepartment: nullableText(100).optional(),
  address: nullableText(1000).optional(),
  invoiceRegistrationNumber: nullableText(50).optional(),
  isInvoiceIssuer: z.boolean().optional(),
  withholdingEnabled: z.boolean().optional(),
  isActive: z.boolean().optional()
}).refine((value) => Object.keys(value).length > 0, {
  message: "更新するフィールドを1つ以上指定してください"
});

export type VendorCreateInput = z.infer<typeof vendorCreateSchema>;
export type VendorUpdateInput = z.infer<typeof vendorUpdateSchema>;
