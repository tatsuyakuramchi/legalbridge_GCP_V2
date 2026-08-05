import type { DatabasePool } from "../db/pool.js";
import { buildLineageCascade, type LineageCascade, type LineageTierInput } from "./receivable-map.js";

// 債権マップの読み取り。作品の派生系譜（root→selected）を辿り、各段の受領合計と
// 上流（親ライセンスイン）料率を集めて純関数 buildLineageCascade に渡す。
// read-only。権限不足・未整備テーブル（42501/42P01/42703）では null で縮退。
// V2 の condition_lines モデルに合わせ、上流は parent_license_condition_id →
// 親の rate_pct（分配スライスと同一の解釈）で近似する。

export interface ReceivableMapRepository {
  forWork(workId: number): Promise<LineageCascade | null>;
}

const MAX_DEPTH = 20;

export class PgReceivableMapRepository implements ReceivableMapRepository {
  constructor(private readonly database: DatabasePool) {}

  async forWork(workId: number): Promise<LineageCascade | null> {
    try {
      // 1. 派生系譜（selected→root）を辿り、root→selected 順に並べる。
      const lineage = await this.database.query(
        `WITH RECURSIVE up AS (
           SELECT id, parent_work_id, title, work_code, 0 AS depth
             FROM works WHERE id = $1
           UNION ALL
           SELECT w.id, w.parent_work_id, w.title, w.work_code, up.depth + 1
             FROM works w JOIN up ON w.id = up.parent_work_id
            WHERE up.depth < ${MAX_DEPTH}
         )
         SELECT id, title, work_code, depth FROM up ORDER BY depth DESC`,
        [workId]
      );
      if (!lineage.rows.length) return null;

      const tiers: LineageTierInput[] = [];
      for (const w of lineage.rows) {
        const id = Number(w.id);
        const [received, upstream] = await Promise.all([
          this.database.query(
            `SELECT COALESCE(SUM(COALESCE(cr.received_amount, cr.computed_royalty_ex_tax)), 0) AS received
               FROM condition_receipts cr
               JOIN condition_lines cl ON cl.id = cr.condition_line_id
              WHERE cl.source_work_id = $1 AND cl.direction = 'receivable'`,
            [id]
          ),
          this.database.query(
            `SELECT DISTINCT cl.parent_license_condition_id AS cap, p.rate_pct, pv.vendor_name AS licensor
               FROM condition_lines cl
               LEFT JOIN condition_lines p ON p.id = cl.parent_license_condition_id
               LEFT JOIN vendors pv ON pv.id = p.counterparty_vendor_id
              WHERE cl.source_work_id = $1 AND cl.direction = 'receivable'
                AND cl.parent_license_condition_id IS NOT NULL`,
            [id]
          )
        ]);
        tiers.push({
          workId: id,
          workTitle: (w.title as string) ?? null,
          workCode: (w.work_code as string) ?? null,
          received: Number(received.rows[0]?.received ?? 0),
          upstream: upstream.rows.map((u) => ({
            capabilityId: u.cap == null ? null : Number(u.cap),
            ratePct: u.rate_pct == null ? null : Number(u.rate_pct),
            licensorName: (u.licensor as string) ?? null
          }))
        });
      }
      return buildLineageCascade(tiers);
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === "42501" || code === "42P01" || code === "42703") return null;
      throw error;
    }
  }
}

export class MemoryReceivableMapRepository implements ReceivableMapRepository {
  constructor(private readonly byWork = new Map<number, LineageTierInput[]>()) {}

  async forWork(workId: number): Promise<LineageCascade | null> {
    const tiers = this.byWork.get(workId);
    if (!tiers) return null;
    return buildLineageCascade(tiers);
  }
}
