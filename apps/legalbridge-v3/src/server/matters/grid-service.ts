import type { Transactable } from "../core/db.js";
import { dateStr, int, str } from "../core/db.js";
import { translate } from "../core/errors.js";
import { SETTLEMENT_COLUMNS, SETTLEMENT_LATERAL_SQL, settlementOf } from "../conditions/settlement.js";
import { phaseOf } from "../documents/repository.js";
import type { GridDocument, GridRow } from "./grid.js";

/**
 * 工程表の行を引く。
 *
 * 条件1本につき、予定・発注書・実績・検収書・支払を1回の問い合わせで畳む。
 * 画面から段ごとに引くと、条件36本の案件で問い合わせが200回近くになる。
 *
 * 改訂した条件は、実績も割当も旧版の id に付いたまま残る。だから文書も実績も
 * 支払も「系列（改訂の全版）」で探す。今の版だけ見ると、改訂した瞬間に
 * 発注書も実績も消えたように見える。
 */

/** 条件の系列（改訂の全版）。 */
const SERIES = `(SELECT x.id FROM conditions x
   WHERE COALESCE(x.series_id, x.id) = COALESCE(c.series_id, c.id))`;

/** 発注書のひな形。条件の側の文書。 */
const ORDER_KEYS = "('purchase_order', 'intl_purchase_order')";
/** 結果の文書。検収書と計算書。 */
const RESULT_KEYS = "('inspection_certificate', 'royalty_statement')";

/**
 * 系列に繋がった文書のうち、その段の代表を1枚。
 * 決定済みを下書きより先に採る（下書きが残っていても、決めたものが現状）。
 */
const documentLateral = (alias: string, keys: string) => `
  LEFT JOIN LATERAL (
    SELECT d.id, d.document_no, d.status,
           (SELECT max(a.occurred_at) FROM audit_events a
             WHERE a.target_type = 'document' AND a.target_id = d.id
               AND a.action IN ('gmail.send', 'cloudsign.send')) AS sent_at
      FROM document_conditions dc
      JOIN documents d ON d.id = dc.document_id
      JOIN document_template_versions tv ON tv.id = d.template_version_id
      JOIN document_templates t ON t.id = tv.template_id
     WHERE dc.condition_id IN ${SERIES}
       AND t.template_key IN ${keys}
       AND d.status <> 'void'
     ORDER BY (d.status = 'draft'), d.issued_at DESC NULLS LAST, d.id DESC
     LIMIT 1
  ) ${alias} ON true`;

const doc = (row: Record<string, any>, prefix: string): GridDocument | null => {
  const id = int(row[`${prefix}_id`]);
  if (!id) return null;
  return {
    id,
    documentNo: str(row[`${prefix}_no`]),
    phase: phaseOf(String(row[`${prefix}_status`]), row[`${prefix}_sent_at`])
  };
};

export class MatterGridService {
  constructor(private readonly database: Transactable) {}

  async rows(matterId: number): Promise<GridRow[]> {
    try {
      const r = await this.database.query(
        `SELECT c.id, c.condition_no, c.name, c.kind, c.status, c.currency,
                c.pricing_model, c.flat_amount, c.unit_amount, c.rate_ppm, c.term_end,
                p.id AS party_id, p.name AS party_name,
                ${SETTLEMENT_COLUMNS},
                sch.total AS schedule_total, sch.done AS schedule_done,
                ev.count AS event_count, ev.latest_on AS event_latest_on, ev.latest_id AS event_latest_id,
                po.id AS order_id, po.document_no AS order_no, po.status AS order_status,
                po.sent_at AS order_sent_at,
                rs.id AS result_id, rs.document_no AS result_no, rs.status AS result_status,
                rs.sent_at AS result_sent_at,
                pay.id AS payment_id, pay.payment_no, pay.status AS payment_status,
                pay.due_on AS payment_due_on, pay.note AS payment_note
           FROM matter_links ml
           JOIN conditions c ON ml.target_type = 'condition' AND c.id::text = ml.target_ref
           LEFT JOIN parties p ON p.id = c.counterparty_id
           ${SETTLEMENT_LATERAL_SQL}
           -- 予定の回と、そのうち実績の付いた回。
           LEFT JOIN LATERAL (
             SELECT count(*)::int AS total,
                    count(*) FILTER (WHERE EXISTS (
                      SELECT 1 FROM condition_events e
                       WHERE e.schedule_id = s.id AND e.status = 'active'))::int AS done
               FROM condition_schedules s WHERE s.condition_id = c.id
           ) sch ON true
           -- 実績は系列ぜんぶから。改訂しても消えない。
           LEFT JOIN LATERAL (
             SELECT count(*)::int AS count, max(e.occurred_on) AS latest_on,
                    (SELECT x.id FROM condition_events x
                      WHERE x.condition_id IN ${SERIES} AND x.status = 'active'
                      ORDER BY x.occurred_on DESC NULLS LAST, x.id DESC LIMIT 1) AS latest_id
               FROM condition_events e
              WHERE e.condition_id IN ${SERIES} AND e.status = 'active'
           ) ev ON true
           ${documentLateral("po", ORDER_KEYS)}
           ${documentLateral("rs", RESULT_KEYS)}
           -- 支払。取り消したものは持っていないものとして扱う。
           LEFT JOIN LATERAL (
             SELECT y.id, y.payment_no, y.status, y.due_on, y.note
               FROM payment_allocations al
               JOIN payments y ON y.id = al.payment_id
              WHERE al.condition_id IN ${SERIES} AND y.status <> 'canceled'
              ORDER BY (y.status = 'paid') DESC, y.id DESC
              LIMIT 1
           ) pay ON true
          WHERE ml.matter_id = $1
            AND c.status NOT IN ('void', 'superseded')
          ORDER BY p.name NULLS LAST, c.condition_no NULLS LAST, c.id`, [matterId]);

      return (r.rows as any[]).map((row) => ({
        conditionId: Number(row.id),
        conditionNo: str(row.condition_no),
        name: String(row.name),
        kind: String(row.kind),
        counterparty: row.party_id ? { id: Number(row.party_id), name: String(row.party_name ?? "") } : null,
        pricingModel: String(row.pricing_model ?? "none"),
        currency: String(row.currency ?? "JPY"),
        flatAmount: int(row.flat_amount),
        unitAmount: int(row.unit_amount),
        ratePpm: int(row.rate_ppm),
        status: String(row.status),
        settlement: settlementOf(row),
        schedules: { total: Number(row.schedule_total ?? 0), done: Number(row.schedule_done ?? 0) },
        order: doc(row, "order"),
        events: {
          count: Number(row.event_count ?? 0), latestOn: dateStr(row.event_latest_on),
          latestId: int(row.event_latest_id)
        },
        settlementDoc: doc(row, "result"),
        payment: row.payment_id
          ? {
              id: Number(row.payment_id), paymentNo: str(row.payment_no),
              status: String(row.payment_status),
              dueOn: dateStr(row.payment_due_on), note: str(row.payment_note)
            }
          : null
      }));
    } catch (error) { throw translate(error); }
  }
}
