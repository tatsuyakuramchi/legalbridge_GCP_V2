import { z } from "zod";

// Aligned with the shared production vendors table (V1 schema).
// 代表者（vendor_rep）・法人番号は帳票へ差し込むため通常項目として扱う。
// 口座情報（BANK_FIELD_KEYS）は機微情報：V1 の VendorsPanel と同じく管理者のみ
// 参照・更新できる（ルート側で判定。非管理者の PATCH は当該キーを含められない）。
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
  // 送信用メール2欄（2026-09-02）: 担当者宛の通知メールと CloudSign 署名者。
  // どちらも文書詳細「外部連携」の宛先候補に引用される。
  contactEmail: nullableText(255),
  signerEmail: nullableText(255),
  address: nullableText(1000),
  invoiceRegistrationNumber: nullableText(50),
  // 法人登録で使う項目（帳票の代表者欄・法人番号）。
  vendorRep: nullableText(200),
  corporateNumber: nullableText(20),
  // 振込先（発注書・支払通知書等へ差し込む）。管理者のみ。
  bankName: nullableText(100),
  branchName: nullableText(100),
  accountType: nullableText(50),
  accountNumber: nullableText(50),
  accountHolderKana: nullableText(100),
  bankInfo: nullableText(1000),
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
  contactEmail: nullableText(255).optional(),
  signerEmail: nullableText(255).optional(),
  address: nullableText(1000).optional(),
  invoiceRegistrationNumber: nullableText(50).optional(),
  vendorRep: nullableText(200).optional(),
  corporateNumber: nullableText(20).optional(),
  bankName: nullableText(100).optional(),
  branchName: nullableText(100).optional(),
  accountType: nullableText(50).optional(),
  accountNumber: nullableText(50).optional(),
  accountHolderKana: nullableText(100).optional(),
  bankInfo: nullableText(1000).optional(),
  isInvoiceIssuer: z.boolean().optional(),
  withholdingEnabled: z.boolean().optional(),
  isActive: z.boolean().optional()
}).refine((value) => Object.keys(value).length > 0, {
  message: "更新するフィールドを1つ以上指定してください"
});

// 口座情報のキー（管理者限定の判定に使う。ルート・クライアント双方の単一情報源）。
export const BANK_FIELD_KEYS = [
  "bankName", "branchName", "accountType", "accountNumber", "accountHolderKana", "bankInfo"
] as const;

export type VendorCreateInput = z.infer<typeof vendorCreateSchema>;
export type VendorUpdateInput = z.infer<typeof vendorUpdateSchema>;
