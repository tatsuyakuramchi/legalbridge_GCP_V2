import type { Queryable } from "../core/db.js";

/**
 * 無効（void）にした条件の「新しい方」：同じ 作品 × 相手先 × 向き × 種類 × 利用形態 × パート の生きている条件
 * （重複を 1 本にしたときの残した側）。いちばん新しい id。作品の無い条件は対象にしない。
 * 文書（下書き・訂正版）が無効の条件を指していたら、こちらに付け替える。
 */
export async function voidSuccessors(client: Queryable, conditionIds: number[]): Promise<Map<number, number>> {
  const ids = [...new Set(conditionIds)].filter((n) => n > 0);
  if (!ids.length) return new Map();
  const r = await client.query(
    `SELECT DISTINCT ON (c.id) c.id, d.id AS successor_id
       FROM conditions c
       JOIN conditions d ON d.id <> c.id AND d.status IN ('active', 'scheduled')
            AND d.counterparty_id = c.counterparty_id AND d.direction = c.direction AND d.kind = c.kind
            AND d.work_id IS NOT DISTINCT FROM c.work_id AND d.usage_type IS NOT DISTINCT FROM c.usage_type
            AND d.work_part_id IS NOT DISTINCT FROM c.work_part_id
      WHERE c.id = ANY($1::bigint[]) AND c.status = 'void' AND c.work_id IS NOT NULL
      ORDER BY c.id, d.id DESC`, [ids]);
  return new Map((r.rows as Array<{ id: unknown; successor_id: unknown }>)
    .map((x) => [Number(x.id), Number(x.successor_id)] as [number, number])
    .filter(([id, to]) => Number.isFinite(id) && Number.isFinite(to) && to > 0 && to !== id));
}

