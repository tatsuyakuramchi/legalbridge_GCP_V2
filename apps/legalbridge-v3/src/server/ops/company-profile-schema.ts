import { z } from "zod";
import {
  COMPANY_PROFILE_FIELDS, type CompanyProfile, type CompanyProfileField
} from "./company-profile.js";

/**
 * 自社情報の検証。zod を使うのでサーバ側だけ。
 * 項目の定義は company-profile.ts（設定画面と共用）にある。
 */

/**
 * 未入力は空文字。キーごと落とすと、読む側が「まだ移行していない」のか
 * 「空と決めた」のかを区別できない。
 */
export const companyProfileSchema = z.object(
  Object.fromEntries(
    COMPANY_PROFILE_FIELDS.map((f) => [f.name, z.string().trim().max(500).default("")])
  ) as Record<CompanyProfileField, z.ZodDefault<z.ZodString>>
).strict();

/** 保存前に整える。知らないキーは弾く（打ち間違いが黙って入ると誰も読まない）。 */
export function parseCompanyProfile(value: unknown): CompanyProfile {
  return companyProfileSchema.parse(value ?? {}) as CompanyProfile;
}
