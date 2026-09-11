import type { Queryable } from "../core/db.js";
import { DomainError } from "./errors.js";

/**
 * 業務番号の採番。
 *
 * 文書の採番（documents/numbering.ts）は `ARC-` 固定・4桁で、既存の発番形式を
 * 変えない互換境界として独立させてある。こちらは案件・条件・取引先・支払など
 * それ以外のための一般形。
 *
 * 並行稼働中は V1 も同じ番号空間で採番するので、確保した番号が既に使われている
 * ことがある。「番号を進める → 実在を確かめる → 空いていれば使う」を繰り返し、
 * 衝突しても落ちないようにする。
 */

/** 採番は東京の年で切る（V1・V2 と同じ）。 */
export function currentYearInTokyo(now = new Date()): number {
  return Number(new Intl.DateTimeFormat("en", { timeZone: "Asia/Tokyo", year: "numeric" }).format(now));
}

export interface NumberSpec {
  /** 採番の接頭辞。document_sequences のキーにもなる。 */
  prefix: string;
  /** 実在を確かめる表。 */
  table: string;
  /** 実在を確かめる列。 */
  column: string;
  /** 連番の桁。既存データに合わせる。 */
  width?: number;
}

export function formatNumber(prefix: string, year: number, sequence: number, width = 5): string {
  return `${prefix}-${year}-${String(sequence).padStart(width, "0")}`;
}

/**
 * その接頭辞・年で既に使われている最大の連番。
 * 移行してきた番号（V1 が振ったもの）から続けるために使う。
 */
export async function maxUsedSequence(
  client: Queryable, spec: NumberSpec, year: number
): Promise<number> {
  const pattern = `${spec.prefix}-${year}-%`;
  const r = await client.query(
    `SELECT COALESCE(MAX(NULLIF(regexp_replace(${spec.column}, '^.*-', ''), '')::int), 0) AS m
       FROM ${spec.table}
      WHERE ${spec.column} LIKE $1
        AND ${spec.column} ~ ('^' || $2 || '-' || $3 || '-[0-9]+$')`,
    [pattern, spec.prefix, String(year)]
  );
  return Number((r.rows[0] as { m: number } | undefined)?.m ?? 0);
}

/**
 * 未使用の番号を1つ確保する。同じトランザクション内で呼ぶこと。
 *
 * 初回は移行データの最大値から始める。そうしないと 1 から振り直しになり、
 * 既存の番号と何百回もぶつかる。
 */
export async function allocateNumber(
  client: Queryable, spec: NumberSpec, now = new Date(), attempts = 50
): Promise<string> {
  const year = currentYearInTokyo(now);
  const width = spec.width ?? 5;

  // 未採番なら移行データの続きから始める。
  const seeded = await client.query(
    "SELECT 1 FROM document_sequences WHERE prefix = $1 AND year = $2", [spec.prefix, year]);
  if (!seeded.rows[0]) {
    const start = await maxUsedSequence(client, spec, year);
    await client.query(
      `INSERT INTO document_sequences (prefix, year, current_value) VALUES ($1, $2, $3)
       ON CONFLICT (prefix, year) DO NOTHING`, [spec.prefix, year, start]);
  }

  for (let i = 0; i < attempts; i += 1) {
    const next = await client.query(
      `UPDATE document_sequences SET current_value = current_value + 1
        WHERE prefix = $1 AND year = $2 RETURNING current_value`, [spec.prefix, year]);
    const sequence = Number((next.rows[0] as { current_value: number }).current_value);
    const candidate = formatNumber(spec.prefix, year, sequence, width);

    const taken = await client.query(
      `SELECT 1 FROM ${spec.table} WHERE ${spec.column} = $1`, [candidate]);
    if (!taken.rows[0]) return candidate;
    // V1 が先に使っていた。次へ進む。
  }
  throw new DomainError(
    "CONFLICT",
    `${spec.prefix} の番号を ${attempts} 回試しても確保できませんでした。採番表を確認してください`);
}
