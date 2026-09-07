import type { Transactable } from "../core/db.js";
import { dateStr, str } from "../core/db.js";
import { translate } from "../core/errors.js";
import { checkAgainstEnvelope } from "../works/envelope.js";
import { WorkRepository } from "../works/repository.js";
import type { EnvelopeCheck, ScopeType } from "../core/model.js";

export interface WorkMonitorRow {
  workId: number;
  workCode: string | null;
  title: string;
  acquiredCount: number;
  grantedCount: number;
  termLimit: string | null;
  termLimitedBy: string | null;
  /** 上限を外れている展開。案件をまたいで拾う。 */
  violations: Array<{
    conditionId: number; conditionNo: string | null; counterparty: string | null;
    check: EnvelopeCheck;
  }>;
}

/**
 * 案件をまたいで積み上がるものを見る。
 * 作品の権利上限は複数の案件で作られた条件から決まるので、
 * 案件詳細では分からない。ここで横断して照合する。
 */
export class MonitoringRepository {
  private readonly works: WorkRepository;
  constructor(private readonly database: Transactable) {
    this.works = new WorkRepository(database);
  }

  async workMonitor(limit = 50): Promise<WorkMonitorRow[]> {
    try {
      const targets = await this.database.query(
        `SELECT w.id, w.work_code, w.title,
                count(*) FILTER (WHERE c.direction = 'out') AS granted
           FROM works w
           JOIN conditions c ON c.work_id = w.id AND c.status = 'active'
          GROUP BY w.id, w.work_code, w.title
         HAVING count(*) FILTER (WHERE c.direction = 'out') > 0
          ORDER BY granted DESC, w.id
          LIMIT $1`, [Math.min(Math.max(limit, 1), 200)]);

      const rows: WorkMonitorRow[] = [];
      for (const target of targets.rows as Array<Record<string, any>>) {
        const workId = Number(target.id);
        const envelope = await this.works.envelope(workId);
        if (!envelope) continue;

        const granted = await this.database.query(
          `SELECT c.id, c.condition_no, c.term_end, c.exclusivity, c.sublicensable,
                  p.name AS party_name,
                  COALESCE(json_agg(json_build_object('scopeType', s.scope_type, 'label', s.label))
                           FILTER (WHERE s.label IS NOT NULL), '[]') AS scopes
             FROM conditions c
             LEFT JOIN parties p ON p.id = c.counterparty_id
             LEFT JOIN condition_scopes s ON s.condition_id = c.id
            WHERE c.work_id = $1 AND c.direction = 'out' AND c.status = 'active'
            GROUP BY c.id, c.condition_no, c.term_end, c.exclusivity, c.sublicensable, p.name`,
          [workId]);

        const violations: WorkMonitorRow["violations"] = [];
        for (const g of granted.rows as Array<Record<string, any>>) {
          const check = checkAgainstEnvelope({
            scopes: ((g.scopes as Array<{ scopeType: string; label: string }>) ?? [])
              .map((s) => ({ scopeType: s.scopeType as ScopeType, label: s.label, code: null })),
            termEnd: dateStr(g.term_end),
            exclusivity: g.exclusivity ?? null,
            sublicensable: g.sublicensable ?? null
          }, envelope);
          if (check.verdict === "outside") {
            violations.push({
              conditionId: Number(g.id),
              conditionNo: str(g.condition_no),
              counterparty: str(g.party_name),
              check
            });
          }
        }

        rows.push({
          workId,
          workCode: envelope.workCode,
          title: envelope.title,
          acquiredCount: envelope.acquiredCount,
          grantedCount: Number(target.granted ?? 0),
          termLimit: envelope.termLimit,
          termLimitedBy: envelope.termLimitedBy,
          violations
        });
      }
      return rows;
    } catch (error) { throw translate(error); }
  }

  /** 業務委託の段階ごとの件数。案件のフロー種別を軸に数える。 */
  async outsourcingPipeline() {
    try {
      const r = await this.database.query(
        `SELECT
           (SELECT count(*)::int FROM agreements WHERE direction = 'in' AND status = 'executed') AS agreements,
           (SELECT count(*)::int FROM documents d
              JOIN document_conditions dc ON dc.document_id = d.id
              JOIN conditions c ON c.id = dc.condition_id
             WHERE d.status = 'issued' AND c.direction = 'in')                                   AS ordered,
           (SELECT count(*)::int FROM condition_events
             WHERE event_type = 'delivery' AND status = 'active')                                AS delivered,
           (SELECT count(*)::int FROM condition_events
             WHERE event_type = 'inspection' AND status = 'active')                              AS inspected,
           (SELECT count(*)::int FROM payments WHERE direction = 'out' AND status <> 'paid')      AS unpaid`);
      const row = r.rows[0] as Record<string, number>;
      return {
        agreements: Number(row.agreements ?? 0),
        ordered: Number(row.ordered ?? 0),
        delivered: Number(row.delivered ?? 0),
        inspected: Number(row.inspected ?? 0),
        unpaid: Number(row.unpaid ?? 0)
      };
    } catch (error) { throw translate(error); }
  }
}
