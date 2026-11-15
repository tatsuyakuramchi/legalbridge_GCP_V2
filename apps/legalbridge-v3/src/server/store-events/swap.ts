import type { Queryable } from "../core/db.js";
import { recordAudit } from "../core/audit.js";

/**
 * 店舗イベント審判の訂正版を決定したときの、条件明細の入れ替え。
 *
 * 訂正版の下書きを作るとき、新しい条件明細は下書き（status = 'draft'）で作り、入れ替える相手（元の
 * 発注書の条件明細）を manual_inputs._storeEvent に控えておく。決定（元の版を退かせる同じトランザクション）で
 *   新しい条件明細 … 下書き → 有効
 *   元の条件明細   … 有効 → 無効（理由を備考に残す）
 * にする。下書きのうちは元が生きているので、二重に数えない。
 *
 * 控えが無い文書（ほかの訂正版）には何もしない。
 */
export async function swapStoreEventConditions(
  client: Queryable, newDocumentId: number, newDocumentNo: string, oldDocumentNo: string | null, actor: string
): Promise<{ activated: number[]; voided: number[] }> {
  const row = (await client.query("SELECT manual_inputs FROM documents WHERE id = $1", [newDocumentId])).rows[0] as
    { manual_inputs: Record<string, any> | null } | undefined;
  const saved = row?.manual_inputs?._storeEvent as { newConditionIds?: unknown[]; replacesConditionIds?: unknown[] } | undefined;
  const ids = (v: unknown) => (Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n > 0) : []);
  const fresh = ids(saved?.newConditionIds);
  const old = ids(saved?.replacesConditionIds).filter((id) => !fresh.includes(id));
  if (!fresh.length && !old.length) return { activated: [], voided: [] };
  const activated = fresh.length ? ((await client.query(
    `UPDATE conditions SET status = 'active', updated_at = now()
      WHERE id = ANY($1::bigint[]) AND status = 'draft' RETURNING id`, [fresh])).rows as Array<{ id: number }>).map((r) => Number(r.id)) : [];
  const voided = old.length ? ((await client.query(
    `UPDATE conditions SET status = 'void', updated_at = now(),
            notes = concat_ws(E'\\n', NULLIF(notes, ''), $2::text)
      WHERE id = ANY($1::bigint[]) AND status IN ('active', 'scheduled', 'draft') RETURNING id`,
    [old, `無効化：発注書 ${oldDocumentNo ?? ""} の訂正版 ${newDocumentNo} の条件明細に置き換えた`])).rows as Array<{ id: number }>).map((r) => Number(r.id)) : [];
  await recordAudit(client, {
    actor, action: "condition.store_event_swap", targetType: "document", targetId: newDocumentId,
    detail: { documentNo: newDocumentNo, supersedesNo: oldDocumentNo, activated, voided }
  });
  return { activated, voided };
}
