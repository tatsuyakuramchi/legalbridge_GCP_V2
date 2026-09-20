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

/**
 * 条件の系列（改訂の全版）。条件を `c` という別名で持つ問い合わせから使う。
 */
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
           -- 決定したときに紙へ載った税抜の合計。
           --
           -- AMOUNT_EX_TAX は条件（または実績）から出した額で、明細の合計とは
           -- 限らない。発注書の明細は人が打てるので、決定済み 23 枚のうち 9 枚が
           -- 「AMOUNT_EX_TAX ¥100,000 ／ 明細の合計 ¥135,000」のように食い違って
           -- いた。相手が読むのは明細の合計のほうなので、そちらを先に採る。
           --   発注書   … grandTotalExTax（明細＋その他手数料）
           --   検収書   … deliveredAmountExTax（納品額）
           --   明細なし … AMOUNT_EX_TAX
           -- 0 は「明細が無い」なので次の欄を見る（明細ゼロ行の発注書は
           -- itemsSubtotalExTax に 0 が入る。拾うと総額 ¥0 として鳴る）。
           COALESCE(
             NULLIF(NULLIF(regexp_replace(COALESCE(d.rendered_values ->> 'grandTotalExTax', ''),
               '[^0-9]', '', 'g'), '')::bigint, 0),
             NULLIF(NULLIF(regexp_replace(COALESCE(d.rendered_values ->> 'deliveredAmountExTax', ''),
               '[^0-9]', '', 'g'), '')::bigint, 0),
             NULLIF(NULLIF(regexp_replace(COALESCE(d.rendered_values ->> 'AMOUNT_EX_TAX', ''),
               '[^0-9]', '', 'g'), '')::bigint, 0)
           ) AS amount_ex_tax,
           -- 同じ系列に、その段のいま有効な文書が何枚あるか。追加発注のように
           -- 何枚にも分かれていると、1枚の総額は条件の総額と合わなくて当たり前。
           --
           -- 数えるのは issued だけ。下書き（作りかけの訂正版）と superseded
           -- （訂正版に退いた旧版）を混ぜると、直そうとしただけで枚数が増えて
           -- 「比べられません」に化ける。
           (SELECT count(DISTINCT d2.id)::int
              FROM document_conditions dc2
              JOIN documents d2 ON d2.id = dc2.document_id AND d2.status = 'issued'
              JOIN document_template_versions tv2 ON tv2.id = d2.template_version_id
              JOIN document_templates t2 ON t2.id = tv2.template_id
             WHERE dc2.condition_id IN ${SERIES} AND t2.template_key IN ${keys}) AS sibling_count,
           (SELECT count(DISTINCT COALESCE(x.series_id, x.id))::int
              FROM document_conditions dx JOIN conditions x ON x.id = dx.condition_id
             WHERE dx.document_id = d.id) AS condition_count,
           -- 焼き付いた日付。回ごとに違う発注書はまとめ書きが入るので、
           -- 日付として読めるかは画面の側（drift.ts）で判じる。
           NULLIF(d.rendered_values ->> 'DELIVERY_DATE', '') AS delivery_on,
           NULLIF(d.rendered_values ->> 'INSPECTION_DATE', '') AS inspection_on,
           NULLIF(d.rendered_values ->> 'PAYMENT_DATE', '') AS payment_on,
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
    phase: phaseOf(String(row[`${prefix}_status`]), row[`${prefix}_sent_at`]),
    amountExTax: int(row[`${prefix}_amount_ex_tax`]),
    conditionCount: Number(row[`${prefix}_condition_count`] ?? 1),
    siblingCount: Number(row[`${prefix}_sibling_count`] ?? 1),
    deliveryOn: str(row[`${prefix}_delivery_on`]),
    inspectionOn: str(row[`${prefix}_inspection_on`]),
    paymentOn: str(row[`${prefix}_payment_on`])
  };
};

/**
 * 行に出す列。条件を `c`、取引先を `p` という別名で持つ問い合わせから使う。
 *
 * 工程表（案件1件ぶん）と、金額の直し（案件をまたいで食い違いだけを拾う）で
 * 同じ列を使う。別々に書くと、片方にだけ欄が増えて判定がずれる。
 */
export const GRID_COLUMNS = `c.id, c.condition_no, c.name, c.kind, c.status, c.currency,
                c.pricing_model, c.flat_amount, c.unit_amount, c.rate_ppm, c.term_end,
                p.id AS party_id, p.name AS party_name,
                ${SETTLEMENT_COLUMNS},
                sch.total AS schedule_total, sch.done AS schedule_done,
                sch.due_on AS schedule_due_on, sch.pay_on AS schedule_pay_on,
                sch.due_kinds, sch.pay_kinds,
                ev.count AS event_count, ev.latest_on AS event_latest_on, ev.latest_id AS event_latest_id,
                ev.latest_inspected_on AS event_latest_inspected_on,
                po.id AS order_id, po.document_no AS order_no, po.status AS order_status,
                po.sent_at AS order_sent_at,
                po.amount_ex_tax AS order_amount_ex_tax,
                po.condition_count AS order_condition_count,
                po.sibling_count AS order_sibling_count,
                po.delivery_on AS order_delivery_on, po.inspection_on AS order_inspection_on,
                po.payment_on AS order_payment_on,
                rs.id AS result_id, rs.document_no AS result_no, rs.status AS result_status,
                rs.sent_at AS result_sent_at,
                rs.amount_ex_tax AS result_amount_ex_tax,
                rs.condition_count AS result_condition_count,
                rs.sibling_count AS result_sibling_count,
                rs.delivery_on AS result_delivery_on, rs.inspection_on AS result_inspection_on,
                rs.payment_on AS result_payment_on,
                pay.id AS payment_id, pay.payment_no, pay.status AS payment_status,
                pay.due_on AS payment_due_on, pay.note AS payment_note`;

/**
 * 行を組み立てる横結合。`FROM ... conditions c` のあとに差す。
 * 取引先（p）だけは呼ぶ側の JOIN 順に関わるのでここに含める。
 */
export const GRID_JOINS = `
           LEFT JOIN parties p ON p.id = c.counterparty_id
           ${SETTLEMENT_LATERAL_SQL}
           -- 予定の回と、そのうち実績の付いた回。
           LEFT JOIN LATERAL (
             SELECT count(*)::int AS total,
                    count(*) FILTER (WHERE EXISTS (
                      SELECT 1 FROM condition_events e
                       WHERE e.schedule_id = s.id AND e.status = 'active'))::int AS done,
                    -- 回ごとに日付が違えば、発注書はまとめ書きになる。
                    -- 種類が1つのときだけ「この日」と言える（NULL は数えない）。
                    count(DISTINCT s.due_on)::int AS due_kinds, max(s.due_on) AS due_on,
                    count(DISTINCT s.pay_on)::int AS pay_kinds, max(s.pay_on) AS pay_on
               FROM condition_schedules s WHERE s.condition_id = c.id
           ) sch ON true
           -- 実績は系列ぜんぶから。改訂しても消えない。
           LEFT JOIN LATERAL (
             SELECT count(*)::int AS count, max(e.occurred_on) AS latest_on,
                    -- 検収日は納品日と別の日になりうる。入っていなければ納品日。
                    max(COALESCE(e.inspected_on, e.occurred_on)) AS latest_inspected_on,
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
           ) pay ON true`;

/** 1行に組む。列は GRID_COLUMNS のもの。 */
export const gridRowOf = (row: Record<string, any>): GridRow => ({
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
  schedules: {
    total: Number(row.schedule_total ?? 0), done: Number(row.schedule_done ?? 0),
    dueOn: Number(row.due_kinds ?? 0) === 1 ? dateStr(row.schedule_due_on) : null,
    payOn: Number(row.pay_kinds ?? 0) === 1 ? dateStr(row.schedule_pay_on) : null,
    dueVaries: Number(row.due_kinds ?? 0) > 1, payVaries: Number(row.pay_kinds ?? 0) > 1
  },
  order: doc(row, "order"),
  events: {
    count: Number(row.event_count ?? 0), latestOn: dateStr(row.event_latest_on),
    latestId: int(row.event_latest_id),
    latestInspectedOn: dateStr(row.event_latest_inspected_on)
  },
  settlementDoc: doc(row, "result"),
  payment: row.payment_id
    ? {
        id: Number(row.payment_id), paymentNo: str(row.payment_no),
        status: String(row.payment_status),
        dueOn: dateStr(row.payment_due_on), note: str(row.payment_note)
      }
    : null
});

export class MatterGridService {
  constructor(private readonly database: Transactable) {}

  async rows(matterId: number): Promise<GridRow[]> {
    try {
      const r = await this.database.query(
        `SELECT ${GRID_COLUMNS}
           FROM matter_links ml
           JOIN conditions c ON ml.target_type = 'condition' AND c.id::text = ml.target_ref
           ${GRID_JOINS}
          WHERE ml.matter_id = $1
            AND c.status NOT IN ('void', 'superseded')
          ORDER BY p.name NULLS LAST, c.condition_no NULLS LAST, c.id`, [matterId]);
      return (r.rows as any[]).map(gridRowOf);
    } catch (error) { throw translate(error); }
  }
}
