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
  const e = error as { code?: string; column?: string; constraint?: string; detail?: string; message?: string };
  const code = e?.code;
  if (code === "42501") return new DomainError("DB_FORBIDDEN", "この操作の権限が付与されていません");
  if (code === "42P01") return new DomainError("DB_FORBIDDEN", "対象のテーブルがまだ作られていません");
  // 台帳の制約に当たったときは、何に当たったかを言う。「サーバ内部でエラー」だけだと
  // 直しようがない（実際、改訂の番号がぶつかった一意制約がそう見えていた）。
  if (code === "42703") {
    return new DomainError("DB_FORBIDDEN",
      `台帳にまだ無い列を使おうとしました（${e.message ?? ""}）。ops upgrade で台帳を最新にしてください`);
  }
  if (code === "23505") {
    return new DomainError("CONFLICT",
      `同じ値がすでにあります（${e.constraint ?? "一意制約"}${e.detail ? `：${e.detail}` : ""}）`);
  }
  if (code === "23502") {
    return new DomainError("VALIDATION", `${e.column ?? "必須の欄"} が空です`);
  }
  if (code === "23514") {
    return new DomainError("VALIDATION", `台帳の決まりに合いません（${e.constraint ?? "check"}）`);
  }
  if (code === "23503") {
    return new DomainError("CONFLICT", `参照先が無いか、参照されていて消せません（${e.constraint ?? ""}）`);
  }
  if (code === "22001") return new DomainError("VALIDATION", "入れた文字が長すぎます");
  if (code === "22P02" || code === "22007" || code === "22008") {
    return new DomainError("VALIDATION", `値の形が合いません（${e.message ?? ""}）`);
  }
  return error;
}
