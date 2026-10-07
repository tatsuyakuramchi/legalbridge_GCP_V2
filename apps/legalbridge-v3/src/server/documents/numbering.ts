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

// ---------------------------------------------------------------------------
// 訂正版の番号（枝番）
//
// 訂正版は連番を進めない。元の番号に枝番を付ける（ARC-PO-2026-0031 → ARC-PO-2026-0031-R2）。
// 連番を取ると、相手に出した番号と社内の番号が版ごとにずれ、検収書・支払・契約の
// 引き当てがどの版を指しているのか追いにくくなる。枝番なら番号の本体で元が分かる。
//
// 紙とメールに出すのは本体の番号。枝番は社内の番号で、相手には「（改訂 n）」の印として
// 見せる・見せないを訂正版ごとに選ぶ（manual_inputs._showRevision）。
// ---------------------------------------------------------------------------

const REVISION_SUFFIX = /-R(\d+)$/;

/** 枝番を外した本体の番号。枝番が無ければそのまま。 */
export function baseDocumentNumber(documentNo: string): string {
  return documentNo.replace(REVISION_SUFFIX, "");
}

/** 何版目か。枝番が無ければ 1。 */
export function revisionOf(documentNo: string): number {
  const m = REVISION_SUFFIX.exec(documentNo);
  return m ? Number(m[1]) : 1;
}

/** 本体の番号と版から、枝番つきの番号。1 版目は枝番なし。 */
export function revisionNumber(base: string, revision: number): string {
  return revision <= 1 ? base : `${base}-R${revision}`;
}

/**
 * 訂正版の番号。退かせる元の番号の本体に、いまある版の次の枝番を付ける。
 * 同じ本体の番号を持つ文書（元・それ以前の版・無効にした訂正版）を全部数えるので、
 * 無効にした訂正版の枝番は再利用しない（同じ番号の紙が 2 枚できない）。
 */
export async function nextRevisionNumber(client: Queryable, supersededNo: string): Promise<string> {
  const base = baseDocumentNumber(supersededNo);
  const result = await client.query(
    "SELECT document_no FROM documents WHERE document_no = $1 OR document_no LIKE $2",
    [base, `${base}-R%`]);
  let latest = 1;
  for (const r of result.rows as Array<{ document_no: string }>) {
    if (baseDocumentNumber(r.document_no) !== base) continue;   // LIKE は -R10x のような外れも拾う
    latest = Math.max(latest, revisionOf(r.document_no));
  }
  return revisionNumber(base, latest + 1);
}

/** 訂正版の改訂の印を相手に見せるか（manual_inputs._showRevision）。書いていなければ見せる。 */
export function showRevisionOf(manual: Record<string, unknown> | null | undefined): boolean {
  const v = manual?._showRevision;
  if (v === undefined || v === null || v === "") return true;
  return !(v === false || v === 0 || String(v) === "0" || String(v) === "false");
}

/**
 * 紙・メールに出す番号。枝番は出さない。改訂の印を見せるときだけ「（改訂 n）」を添える。
 * 1 版目（枝番なし）はそのまま。
 */
export function printedDocumentNumber(documentNo: string, showRevision: boolean): string {
  const rev = revisionOf(documentNo);
  const base = baseDocumentNumber(documentNo);
  return rev > 1 && showRevision ? `${base}（改訂${rev}）` : base;
}
