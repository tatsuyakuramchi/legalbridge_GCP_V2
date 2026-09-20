import type { Transactable } from "../core/db.js";
import { int, str } from "../core/db.js";
import { translate } from "../core/errors.js";
import { GRID_COLUMNS, GRID_JOINS, gridRowOf } from "./grid-service.js";
import { driftOf, type Drift } from "./drift.js";
import type { GridRow } from "./grid.js";

/**
 * 金額の直し（取り残しの一覧）。
 *
 * 工程表は案件1件の中を見る画面で、食い違いは案件をまたいで散らばる。取引先の
 * 一式を直すときに案件を順に開いて回るのは現実的でないので、食い違いだけを
 * 集めた画面を別に持つ。範囲は案件1件（いま見ている案件）と全社（念のための
 * 確認）の2つ。
 *
 * 判定は drift.ts をそのまま使う。ここで別の条件を書くと、工程表の札と
 * この画面の一覧がいつかずれる。
 *
 * 全社の範囲では条件が数千本になりうるので、SQL の段階で
 * 「決定済みの文書を持つ条件」だけに絞る。焼き付いた値が無ければ取り残しも
 * 起きないので、落としても見逃しにならない。
 */

/** 文書のひな形（工程表と同じ2群）。 */
const DOC_KEYS = `('purchase_order', 'intl_purchase_order',
                   'inspection_certificate', 'royalty_statement')`;

export interface DriftRow {
  row: GridRow;
  drift: Drift;
  /** どの案件の話か。案件に繋がっていない条件もあるので null を許す。 */
  matter: { id: number; matterNo: string | null; title: string } | null;
}

/**
 * 決定を待っている訂正版の下書き。
 *
 * 直しても、訂正版が下書きのままなら紙は古いまま。別画面に飛ばすと1枚の意味が
 * 無いので、この画面に残りとして出す。
 */
export interface PendingDraft {
  id: number;
  /** 退かせる元の文書。 */
  supersedesId: number;
  supersedesNo: string | null;
  templateKey: string | null;
  reason: string | null;
  createdAt: string | null;
  conditionNo: string | null;
  conditionName: string | null;
  partyName: string | null;
  matter: { id: number; matterNo: string | null; title: string } | null;
  /** 下書きの明細に入っている税抜の合計。手入力が無ければ null（条件から出る）。 */
  manualTotal: number | null;
}

const matterOf = (row: Record<string, any>) =>
  row.matter_id
    ? { id: Number(row.matter_id), matterNo: str(row.matter_no), title: String(row.matter_title ?? "") }
    : null;

/** 案件。条件は複数の案件に繋がりうるので、番号の若いほうを代表にする。 */
const MATTER_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT m.id, m.matter_no, m.title
      FROM matter_links ml
      JOIN matters m ON m.id = ml.matter_id
     WHERE ml.target_type = 'condition' AND ml.target_ref = c.id::text
     ORDER BY m.matter_no NULLS LAST, m.id
     LIMIT 1
  ) mt ON true`;

export class DriftService {
  constructor(private readonly database: Transactable) {}

  /** 食い違っている行だけ。matterId を渡すとその案件の中だけを見る。 */
  async rows(matterId: number | null): Promise<DriftRow[]> {
    try {
      const r = await this.database.query(
        `SELECT ${GRID_COLUMNS},
                mt.id AS matter_id, mt.matter_no, mt.title AS matter_title
           FROM conditions c
           ${GRID_JOINS}
           ${MATTER_LATERAL}
          WHERE c.status NOT IN ('void', 'superseded')
            AND ($1::bigint IS NULL OR EXISTS (
                  SELECT 1 FROM matter_links ml
                   WHERE ml.matter_id = $1 AND ml.target_type = 'condition'
                     AND ml.target_ref = c.id::text))
            -- 決定済みの文書を持たない条件に取り残しは起きない（焼き付いた値が
            -- 無い）。全社の範囲で条件を全部組み立てないための足切り。
            AND EXISTS (
                  SELECT 1 FROM document_conditions dc
                    JOIN documents d ON d.id = dc.document_id AND d.status = 'issued'
                    JOIN document_template_versions tv ON tv.id = d.template_version_id
                    JOIN document_templates t ON t.id = tv.template_id
                   WHERE dc.condition_id IN (SELECT x.id FROM conditions x
                          WHERE COALESCE(x.series_id, x.id) = COALESCE(c.series_id, c.id))
                     AND t.template_key IN ${DOC_KEYS})
          ORDER BY mt.matter_no NULLS LAST, p.name NULLS LAST,
                   c.condition_no NULLS LAST, c.id`,
        [matterId]);

      const out: DriftRow[] = [];
      for (const raw of r.rows as any[]) {
        const row = gridRowOf(raw);
        const drift = driftOf(row);
        if (!drift || !drift.flagged.length) continue;
        out.push({ row, drift, matter: matterOf(raw) });
      }
      return out;
    } catch (error) { throw translate(error); }
  }

  /** 決定を待っている訂正版の下書き。 */
  async drafts(matterId: number | null): Promise<PendingDraft[]> {
    try {
      const r = await this.database.query(
        `SELECT d.id, d.supersedes_id, d.supersede_reason, d.created_at,
                o.document_no AS supersedes_no, t.template_key,
                c.condition_no, c.name AS condition_name, p.name AS party_name,
                mt.id AS matter_id, mt.matter_no, mt.title AS matter_title,
                -- 手入力の明細の税抜合計。入っていれば条件より強いので、
                -- 画面はこの額が紙に載ると言える。
                (SELECT sum((NULLIF(regexp_replace(
                              COALESCE(i ->> 'amount_ex_tax', i ->> 'amount', ''),
                              '[^0-9]', '', 'g'), ''))::bigint)
                   FROM jsonb_array_elements(
                          CASE WHEN jsonb_typeof(d.manual_inputs -> 'items') = 'array'
                               THEN d.manual_inputs -> 'items' ELSE '[]'::jsonb END) i
                ) AS manual_total
           FROM documents d
           JOIN documents o ON o.id = d.supersedes_id
           LEFT JOIN document_template_versions tv ON tv.id = d.template_version_id
           LEFT JOIN document_templates t ON t.id = tv.template_id
           LEFT JOIN LATERAL (
             SELECT x.condition_no, x.name, x.counterparty_id, x.id
               FROM document_conditions dc JOIN conditions x ON x.id = dc.condition_id
              WHERE dc.document_id = d.id ORDER BY dc.line_no, dc.condition_id LIMIT 1
           ) c ON true
           LEFT JOIN parties p ON p.id = c.counterparty_id
           ${MATTER_LATERAL}
          WHERE d.status = 'draft' AND d.supersedes_id IS NOT NULL
            AND ($1::bigint IS NULL OR mt.id = $1)
          ORDER BY d.created_at DESC NULLS LAST, d.id DESC`, [matterId]);

      return (r.rows as any[]).map((row) => ({
        id: Number(row.id),
        supersedesId: Number(row.supersedes_id),
        supersedesNo: str(row.supersedes_no),
        templateKey: str(row.template_key),
        reason: str(row.supersede_reason),
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        conditionNo: str(row.condition_no),
        conditionName: str(row.condition_name),
        partyName: str(row.party_name),
        matter: matterOf(row),
        manualTotal: int(row.manual_total)
      }));
    } catch (error) { throw translate(error); }
  }
}
