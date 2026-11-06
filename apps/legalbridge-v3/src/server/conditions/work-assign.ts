import type { Transactable } from "../core/db.js";
import { inTransaction, str } from "../core/db.js";
import { recordAudit } from "../core/audit.js";
import { DomainError, translate } from "../core/errors.js";

/**
 * 条件を作品に入れる（マップで行を選んで「作品に入れる」。docs/navigation.md §11）。
 *
 * 途中から作品を立てて、作品の無い条件をカテゴライズするための入口。Excel で行を足すように、
 * 選んだ条件をまとめて 1 つの作品に寄せる。条件の版の系列ぜんぶに入れる（前の版の行が別の作品に残らない）。
 *
 * 作品がもう付いている条件は、決定した文書が無いときだけ付け替える。決定した文書には作品の名前が
 * 刷られているので、付け替えると紙と食い違う（それは条件の画面で訂正版を作って直す）。
 */
export interface WorkAssignResult {
  workId: number;
  updated: number[];
  skipped: Array<{ conditionId: number; reason: string }>;
}

export class ConditionWorkService {
  constructor(private readonly database: Transactable) {}

  async assign(conditionIds: number[], workId: number, actor: string): Promise<WorkAssignResult> {
    const ids = [...new Set(conditionIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!ids.length) throw new DomainError("VALIDATION", "条件を選んでください");
    try {
      return await inTransaction(this.database, async (client) => {
        const work = (await client.query("SELECT id, title FROM works WHERE id = $1", [workId])).rows[0] as { id: number; title: string } | undefined;
        if (!work) throw new DomainError("NOT_FOUND", `作品 ${workId} が見つかりません`);
        const rows = (await client.query(
          `SELECT c.id, c.work_id, w.title AS work_title, COALESCE(c.series_id, c.id) AS series,
                  EXISTS (SELECT 1 FROM document_conditions dc
                            JOIN documents d ON d.id = dc.document_id AND d.status = 'issued'
                           WHERE dc.condition_id IN (SELECT x.id FROM conditions x
                                                      WHERE COALESCE(x.series_id, x.id) = COALESCE(c.series_id, c.id))) AS issued
             FROM conditions c LEFT JOIN works w ON w.id = c.work_id
            WHERE c.id = ANY($1::bigint[])
            FOR UPDATE OF c`, [ids])).rows as Array<Record<string, any>>;
        const found = new Set(rows.map((r) => Number(r.id)));
        const skipped: WorkAssignResult["skipped"] = ids.filter((id) => !found.has(id))
          .map((id) => ({ conditionId: id, reason: "条件が見つかりません" }));
        const series: number[] = [];
        const updated: number[] = [];
        for (const r of rows) {
          const id = Number(r.id);
          if (r.work_id !== null && Number(r.work_id) === workId) { skipped.push({ conditionId: id, reason: "もうこの作品に入っています" }); continue; }
          if (r.work_id !== null && r.issued === true) {
            skipped.push({ conditionId: id,
              reason: `作品「${str(r.work_title) ?? r.work_id}」で決定した文書があるので付け替えません（条件の画面で訂正版を作って直す）` });
            continue;
          }
          series.push(Number(r.series));
          updated.push(id);
        }
        if (series.length) {
          // 作品のパート（work_part_id）は元の作品のものなので外す。
          await client.query(
            `UPDATE conditions SET work_id = $1, work_part_id = NULL, updated_at = now()
              WHERE COALESCE(series_id, id) = ANY($2::bigint[])`, [workId, series]);
          await recordAudit(client, {
            actor, action: "condition.assign_work", targetType: "work", targetId: workId,
            detail: { conditionIds: updated, skipped }
          });
        }
        return { workId, updated, skipped };
      });
    } catch (error) { throw translate(error); }
  }
}
