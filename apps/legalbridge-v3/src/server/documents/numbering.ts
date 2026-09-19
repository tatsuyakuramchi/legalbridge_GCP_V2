import type { Queryable } from "../core/db.js";

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

/** 連番を1つ進めて返す。同じトランザクション内で呼ぶこと。 */
export async function nextSequence(client: Queryable, prefix: string, year: number): Promise<number> {
  const result = await client.query(
    `INSERT INTO document_sequences (prefix, year, current_value)
     VALUES ($1, $2, 1)
     ON CONFLICT (prefix, year) DO UPDATE
       SET current_value = document_sequences.current_value + 1
     RETURNING current_value`,
    [prefix, year]
  );
  return Number((result.rows[0] as { current_value: number }).current_value);
}
