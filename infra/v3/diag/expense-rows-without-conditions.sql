-- 発注書・検収書の「経費」「その他手数料」の行のうち、条件明細になっていないものの棚卸し。
-- 読み取りだけ。書き換え不要。
--
-- 使い方（予備系の写し）
--   cd infra\local
--   docker compose run --rm ops sql /v3/diag/expense-rows-without-conditions.sql
-- 本番を読むだけで流すなら
--   docker compose run --rm ops sql-prod /v3/diag/expense-rows-without-conditions.sql
--
-- 文書の経費・手数料の行は、決定（発行）のときに fee / expense の条件明細になり、
-- 行に condition_id が書き戻される（server/documents/settlement-conditions.ts）。
-- 作られないのは次のどれか。判定の列にそのまま出す。
--
--   まだ下書き                 … 決定していない。決定すれば作られる
--   ひな形が対象外             … 発注書・海外発注書・検収書・納品書・検収証 以外では作らない
--   文書に条件明細が無い       … 相手先・契約・通貨を先頭の条件（委託料）から写すので、
--                                 繋がる条件が 1 本も無いと黙って作らない（行は紙にだけ残る）
--   条件が消えている           … 行は condition_id を持つが、その条件が無い（削除された）
--   条件が文書に繋がっていない … 条件はあるが document_conditions に無い（人が外した）
--   決定時に作られていない     … 上のどれでもないのに condition_id が無い。決定日が
--                                 この処理の入る前か、決定時に行が無く後から足されたか
--
-- 併せて、条件になっている行でも、紙の名前・金額と条件の名前・金額がずれているものを出す
-- （行を直しても既存の条件には反映されないため）。
--
-- 相手先名・担当者名・連絡先・口座は一切引かない。相手先は出さない。

SET search_path = v3;

\pset pager off
\pset border 0

\echo ''
\echo '=== 0. 行の判定ごとの件数 =============================================='
\echo ''

-- 行の形を 1 度だけ書き、psql の変数に入れて各節で使う（本番は読み取り専用の接続で
-- 流すので、一時表は作れない）。
SELECT $rows$
WITH src AS (
  SELECT d.id AS document_id, d.document_no, d.status, d.issued_at::date AS issued_on,
         t.template_key, d.manual_inputs,
         EXISTS (SELECT 1 FROM document_conditions dc WHERE dc.document_id = d.id) AS has_conditions
    FROM documents d
    LEFT JOIN document_template_versions tv ON tv.id = d.template_version_id
    LEFT JOIN document_templates t ON t.id = tv.template_id
   WHERE d.status IN ('draft', 'issued', 'superseded')
     AND (jsonb_typeof(d.manual_inputs->'expenses') = 'array'
          OR jsonb_typeof(d.manual_inputs->'other_fees') = 'array')
),
line AS (
  SELECT s.*, 'expense'::text AS row_kind, e.ord AS row_no, e.row
    FROM src s
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(s.manual_inputs->'expenses') = 'array' THEN s.manual_inputs->'expenses' ELSE '[]'::jsonb END)
      WITH ORDINALITY AS e(row, ord)
  UNION ALL
  SELECT s.*, 'fee', f.ord, f.row
    FROM src s
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(s.manual_inputs->'other_fees') = 'array' THEN s.manual_inputs->'other_fees' ELSE '[]'::jsonb END)
      WITH ORDINALITY AS f(row, ord)
),
shaped AS (
  SELECT l.document_id, l.document_no, l.status, l.issued_on, l.template_key, l.has_conditions,
         l.row_kind, l.row_no,
         NULLIF(trim(COALESCE(l.row->>'expense_name', l.row->>'fee_name', '')), '') AS row_name,
         -- 経費は税込の欄が先、無ければ金額の欄。手数料は金額の欄。画面は空欄を '' で持つ。
         NULLIF(regexp_replace(COALESCE(
           CASE WHEN l.row_kind = 'expense' THEN NULLIF(l.row->>'amount_inc_tax', '') END,
           NULLIF(l.row->>'amount', '')), '[^0-9.-]', '', 'g'), '')::numeric AS row_amount,
         NULLIF(regexp_replace(COALESCE(l.row->>'condition_id', ''), '[^0-9]', '', 'g'), '')::bigint AS condition_id
    FROM line l
),
rowset AS (
SELECT s.*,
       c.id IS NOT NULL AS condition_exists,
       c.name AS condition_name, c.flat_amount AS condition_amount, c.status AS condition_status,
       EXISTS (SELECT 1 FROM document_conditions dc
                WHERE dc.document_id = s.document_id AND dc.condition_id = s.condition_id) AS condition_linked,
       CASE
         WHEN s.row_name IS NULL AND COALESCE(s.row_amount, 0) <= 0 THEN '空の行（作らない）'
         WHEN s.condition_id IS NOT NULL AND c.id IS NULL THEN '条件が消えている'
         WHEN s.condition_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM document_conditions dc
                WHERE dc.document_id = s.document_id AND dc.condition_id = s.condition_id)
           THEN '条件が文書に繋がっていない'
         WHEN s.condition_id IS NOT NULL THEN '条件あり'
         WHEN s.status = 'draft' THEN 'まだ下書き'
         WHEN s.template_key IS NULL OR s.template_key NOT IN
              ('purchase_order', 'intl_purchase_order', 'inspection_certificate',
               'intl_inspection_certificate', 'delivery_note', 'acceptance_certificate')
           THEN 'ひな形が対象外'
         WHEN NOT s.has_conditions THEN '文書に条件明細が無い'
         ELSE '決定時に作られていない'
       END AS verdict
  FROM shaped s
  LEFT JOIN conditions c ON c.id = s.condition_id
)
$rows$ AS rows_cte \gset

:rows_cte
SELECT verdict AS "判定", row_kind AS "行の種類", count(*) AS "行数",
       count(DISTINCT document_id) AS "文書数"
  FROM rowset
 GROUP BY verdict, row_kind
 ORDER BY (verdict = '条件あり'), verdict, row_kind;

\echo ''
\echo '=== 1. 条件明細になっていない行（1 行ずつ） ============================'
\echo '   文書番号の無いものは下書き（#ID）。金額は紙の行の値。'
\echo ''

:rows_cte
SELECT COALESCE(r.document_no, '#' || r.document_id) AS "文書番号",
       r.template_key AS "ひな形",
       r.status AS "状態",
       r.issued_on AS "決定日",
       CASE r.row_kind WHEN 'expense' THEN '経費' ELSE '手数料' END AS "行",
       r.row_no AS "行番号",
       r.row_name AS "行の名前",
       r.row_amount AS "金額",
       r.condition_id AS "行の condition_id",
       r.verdict AS "判定"
  FROM rowset r
 WHERE r.verdict NOT IN ('条件あり', '空の行（作らない）')
 ORDER BY r.issued_on NULLS LAST, r.document_id, r.row_kind, r.row_no;

\echo ''
\echo '=== 2. 決定済みなのに条件が無い文書の、決定の記録 ======================'
\echo '   決定時の監査（document.issue）に createdConditions があれば、その決定で条件を作っている。'
\echo '   無ければ、決定時にこの処理が走っていない（処理の入る前の決定か、行が後から足された）。'
\echo ''

:rows_cte
SELECT DISTINCT ON (r.document_id)
       COALESCE(r.document_no, '#' || r.document_id) AS "文書番号",
       r.issued_on AS "決定日",
       a.occurred_at::date AS "決定の記録",
       jsonb_array_length(COALESCE(a.detail->'createdConditions', '[]'::jsonb)) AS "その決定で作った条件",
       jsonb_array_length(COALESCE(a.detail->'conditions', '[]'::jsonb)) AS "決定時に載っていた条件"
  FROM rowset r
  LEFT JOIN audit_events a ON a.target_type = 'document' AND a.target_id = r.document_id
                          AND a.action = 'document.issue'
 WHERE r.verdict IN ('決定時に作られていない', '文書に条件明細が無い')
 ORDER BY r.document_id, a.occurred_at DESC;

\echo ''
\echo '=== 3. 条件はあるが、紙の行と名前・金額がずれているもの ================'
\echo '   行を直しても既存の条件には反映されない。条件の側を直すか、訂正版で作り直す。'
\echo ''

:rows_cte
SELECT COALESCE(r.document_no, '#' || r.document_id) AS "文書番号",
       CASE r.row_kind WHEN 'expense' THEN '経費' ELSE '手数料' END AS "行",
       r.row_no AS "行番号",
       r.row_name AS "紙の名前",
       r.condition_name AS "条件の名前",
       r.row_amount AS "紙の金額",
       r.condition_amount AS "条件の金額",
       r.condition_id AS "条件 ID",
       r.condition_status AS "条件の状態"
  FROM rowset r
 WHERE r.verdict = '条件あり'
   AND (COALESCE(r.row_name, '') <> COALESCE(r.condition_name, '')
        OR COALESCE(r.row_amount, 0) <> COALESCE(r.condition_amount, 0))
 ORDER BY r.document_id, r.row_kind, r.row_no;
