import type { Queryable } from "../core/db.js";
import { DomainError } from "../core/errors.js";

/** 採番は東京の年で切る（V1・V2 と同じ）。 */
export function currentYearInTokyo(now = new Date()): number {
  return Number(new Intl.DateTimeFormat("en", { timeZone: "Asia/Tokyo", year: "numeric" }).format(now));
}

/** ARC-<prefix>-<year>-<0001>。既存の発番形式を変えない（互換境界）。 */
export function formatDocumentNumber(prefix: string, year: number, sequence: number): string {
  const base = prefix.startsWith("ARC-") ? prefix.slice(4) : prefix;
  return `ARC-${base}-${year}-${String(sequence).padStart(4, "0")}`;
}

export function normalizePrefix(configured: string | null | undefined): string | null {
  const value = String(configured ?? "").trim().toUpperCase();
  if (!value || !/^[A-Z0-9-]{1,20}$/.test(value)) return null;
  return value.startsWith("ARC-") ? value.slice(4) : value;
}

/**
 * 連番を1つ進めて返す。同じトランザクション内で呼ぶこと。
 *
 * 進めた番号の文書がもうあれば（採番表が発行済みの番号より遅れている：本番の
 * 行を取り込んだ手元の DB、別の経路で番号を振った文書など）、使われていない
 * 番号まで 1 つずつ進める。そのまま返すと既にある番号をもう一度振って、
 * 決定が一意制約で止まる。最大値へ一気に飛ばさないのは、外れ値の番号が
 * あると連番が大きく飛ぶため。
 */
export async function nextSequence(
  client: Queryable, prefix: string, year: number, attempts = 5000
): Promise<number> {
  for (let i = 0; i < attempts; i += 1) {
    const result = await client.query(
      `INSERT INTO document_sequences (prefix, year, current_value)
       VALUES ($1, $2, 1)
       ON CONFLICT (prefix, year) DO UPDATE
         SET current_value = document_sequences.current_value + 1
       RETURNING current_value`,
      [prefix, year]
    );
    const sequence = Number((result.rows[0] as { current_value: number }).current_value);
    const taken = await client.query(
      "SELECT 1 FROM documents WHERE document_no = $1", [formatDocumentNumber(prefix, year, sequence)]);
    if (!taken.rows[0]) return sequence;
  }
  throw new DomainError("CONFLICT",
    `文書番号（${prefix}-${year}）を ${attempts} 回試しても確保できませんでした。採番表を確認してください`);
}
