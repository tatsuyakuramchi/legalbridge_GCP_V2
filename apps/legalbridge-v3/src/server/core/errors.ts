export type DomainErrorCode =
  | "NOT_FOUND"
  | "CONFLICT"
  | "FORBIDDEN"
  | "VALIDATION"
  | "READ_ONLY"
  | "DB_FORBIDDEN";

export class DomainError extends Error {
  constructor(readonly code: DomainErrorCode, message: string, readonly detail?: unknown) {
    super(message);
    this.name = "DomainError";
  }
}

export const statusFor = (code: DomainErrorCode): number =>
  code === "NOT_FOUND" ? 404
  : code === "CONFLICT" ? 409
  : code === "FORBIDDEN" ? 403
  : code === "VALIDATION" ? 400
  : 503;

/** PostgreSQL の権限不足・表未整備を、機能縮退できる形の DomainError に変換する。 */
export function translate(error: unknown): unknown {
  const code = (error as { code?: string })?.code;
  if (code === "42501") return new DomainError("DB_FORBIDDEN", "この操作の権限が付与されていません");
  if (code === "42P01") return new DomainError("DB_FORBIDDEN", "対象のテーブルがまだ作られていません");
  return error;
}
