-- 経費・手数料が「条件明細になっていない」と見えるとき、行の形以外の原因を探す。読み取りだけ。
--
-- 使い方
--   docker compose run --rm ops sql-prod /v3/diag/expense-rows-followup.sql   （予備系から本番を読む）
--   Cloud Shell なら psql -f で流す（docs/v3-push-local-to-prod.md「Cloud Shell で本番につなぐ」）。
--
-- expense-rows-without-conditions.sql で「経費」「その他手数料」の行は全部条件になっていると
-- 分かったあとの、次の 3 つの見方。
--
--   1 経費を「経費」の表ではなく、発注明細・納品明細（品目）の行に打っている
--       … 品目の行は委託料の明細なので、条件明細は作らない（経費の表に入れたときだけ作る）
--   2 条件はできているが、文書の案件に繋がっていない
--       … 案件の条件明細タブ・取引を進めるの画面には出ない（条件明細の一覧にはある）
--   3 経費・手数料の条件が、どの文書にも案件にも繋がっていない
--       … 条件明細の一覧でしか見えない
--
-- 相手先名・担当者名・連絡先・口座は一切引かない。

SET search_path = v3;

\pset pager off
\pset border 0

\echo ''
\echo '=== 1. 品目の行に打たれた経費らしきもの（条件明細は作られない行） ======'
\echo '   発注明細（items）・納品明細（delivery_line_items）のうち、名前が経費の語を含む行。'
\echo ''

WITH doc AS (
  SELECT d.id, d.document_no, d.status, d.issued_at::date AS issued_on, t.template_key, d.manual_inputs
    FROM documents d
    LEFT JOIN document_template_versions tv ON tv.id = d.template_version_id
    LEFT JOIN document_templates t ON t.id = tv.template_id
   WHERE d.status IN ('draft', 'issued', 'superseded')
),
line AS (
  SELECT doc.*, 'items'::text AS tbl, r.ord AS row_no, r.row
    FROM doc
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(doc.manual_inputs->'items') = 'array' THEN doc.manual_inputs->'items' ELSE '[]'::jsonb END)
      WITH ORDINALITY AS r(row, ord)
  UNION ALL
  SELECT doc.*, 'delivery_line_items', r.ord, r.row
    FROM doc
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(doc.manual_inputs->'delivery_line_items') = 'array'
           THEN doc.manual_inputs->'delivery_line_items' ELSE '[]'::jsonb END)
      WITH ORDINALITY AS r(row, ord)
)
SELECT COALESCE(l.document_no, '#' || l.id) AS "文書番号",
       l.template_key AS "ひな形",
       l.status AS "状態",
       l.issued_on AS "決定日",
       CASE l.tbl WHEN 'items' THEN '発注明細' ELSE '納品明細' END AS "表",
       l.row_no AS "行番号",
       l.row->>'item_name' AS "品目名",
       NULLIF(regexp_replace(COALESCE(NULLIF(l.row->>'amount_ex_tax', ''), NULLIF(l.row->>'inspected_amount_ex_tax', ''),
                                      NULLIF(l.row->>'amount', ''), ''), '[^0-9.-]', '', 'g'), '')::numeric AS "金額"
  FROM line l
 WHERE COALESCE(l.row->>'item_name', '') ~ '(交通費|宿泊費|旅費|実費|経費|手数料|送料|運賃|立替|郵送|印刷費|振込)'
 ORDER BY l.issued_on NULLS LAST, l.id, l.tbl, l.row_no;

\echo ''
\echo '=== 2. 文書から出た経費・手数料の条件のうち、文書の案件に繋がっていないもの ==='
\echo '   案件の条件明細タブ・取引を進めるの画面には出ない。条件明細の一覧にはある。'
\echo ''

SELECT d.document_no AS "文書番号",
       d.issued_at::date AS "決定日",
       m.matter_no AS "文書の案件",
       c.condition_no AS "条件番号",
       c.kind AS "種類",
       c.name AS "条件の名前",
       c.flat_amount AS "金額",
       c.status AS "条件の状態",
       (SELECT string_agg(mm.matter_no, '・') FROM matter_links ml JOIN matters mm ON mm.id = ml.matter_id
         WHERE ml.target_type = 'condition' AND ml.target_ref = c.id::text) AS "条件が繋がる案件"
  FROM document_conditions dc
  JOIN documents d ON d.id = dc.document_id
  JOIN matters m ON m.id = d.matter_id
  JOIN conditions c ON c.id = dc.condition_id
 WHERE c.kind IN ('expense', 'fee')
   AND d.status IN ('issued', 'superseded')
   AND NOT EXISTS (SELECT 1 FROM matter_links ml
                    WHERE ml.target_type = 'condition' AND ml.target_ref = c.id::text AND ml.matter_id = d.matter_id)
 ORDER BY d.issued_at DESC NULLS LAST, c.id;

\echo ''
\echo '=== 3. 経費・手数料の条件のうち、どの文書にも案件にも繋がっていないもの ======'
\echo '   条件明細の一覧でしか見えない。文書の行から作ったなら備考に「後から足した」か「税込の実費」がある。'
\echo ''

SELECT c.condition_no AS "条件番号",
       c.kind AS "種類",
       c.name AS "条件の名前",
       c.flat_amount AS "金額",
       c.status AS "条件の状態",
       c.created_at::date AS "作った日",
       left(COALESCE(c.notes, ''), 40) AS "備考（先頭）"
  FROM conditions c
 WHERE c.kind IN ('expense', 'fee')
   AND NOT EXISTS (SELECT 1 FROM document_conditions dc WHERE dc.condition_id = c.id)
   AND NOT EXISTS (SELECT 1 FROM matter_links ml WHERE ml.target_type = 'condition' AND ml.target_ref = c.id::text)
 ORDER BY c.created_at DESC
 LIMIT 100;

\echo ''
\echo '=== 4. 経費・手数料の条件の数（全体の輪郭） =============================='
\echo ''

SELECT c.kind AS "種類", c.status AS "状態", count(*) AS "本数",
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM document_conditions dc WHERE dc.condition_id = c.id)) AS "文書あり",
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM matter_links ml
                                       WHERE ml.target_type = 'condition' AND ml.target_ref = c.id::text)) AS "案件あり"
  FROM conditions c
 WHERE c.kind IN ('expense', 'fee')
 GROUP BY c.kind, c.status
 ORDER BY c.kind, c.status;
