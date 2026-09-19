-- =====================================================================
-- 1 枚の文書のまわりの繋がりを読む（読むだけ）
--   文書 → 条件（版・状態）→ 実績（どの文書に結びついているか）→ 案件 → 訂正の鎖
--   「条件と文書の繋がりがおかしい」を切り分けるための診断。
--   先頭の \set で文書番号を指す。Studio なら :'no' を '...' に書き換える。
--   実行: docker compose run --rm ops sql /v3/119_show_document_links.sql
-- =====================================================================
\set no 'ARC-PO-2026-0121'
\pset pager off

\echo '--- 1. その番号の文書（訂正版があれば複数） ---'
SELECT d.id, d.document_no, d.status, d.issued_at::date AS 決定日, d.matter_id, m.matter_no AS 案件,
       d.supersedes_id AS 元の文書, t.template_key AS ひな形
  FROM v3.documents d
  LEFT JOIN v3.matters m ON m.id = d.matter_id
  LEFT JOIN v3.document_template_versions tv ON tv.id = d.template_version_id
  LEFT JOIN v3.document_templates t ON t.id = tv.template_id
 WHERE d.document_no = :'no' ORDER BY d.id;

\echo '--- 2. 文書に繋いだ条件（版と状態。superseded は旧版） ---'
SELECT d.id AS 文書id, dc.line_no, c.id AS 条件id, c.condition_no, c.status, c.kind, c.name,
       c.superseded_by_id AS 新版id, COALESCE(c.series_id, c.id) AS 系列,
       (SELECT string_agg(m.matter_no, ',') FROM v3.matter_links ml JOIN v3.matters m ON m.id = ml.matter_id
         WHERE ml.target_type = 'condition' AND ml.target_ref = c.id::text) AS 紐づく案件
  FROM v3.documents d
  JOIN v3.document_conditions dc ON dc.document_id = d.id
  JOIN v3.conditions c ON c.id = dc.condition_id
 WHERE d.document_no = :'no' ORDER BY d.id, dc.line_no;

\echo '--- 3. それらの条件（系列ぜんぶ）の実績と、結びついている文書 ---'
SELECT e.id AS 実績id, e.condition_id AS 条件id, c.condition_no, c.status AS 条件の状態,
       e.event_type, e.occurred_on, e.amount, e.status AS 実績の状態,
       e.document_id AS 文書id, x.document_no AS 文書, x.status AS 文書の状態
  FROM v3.documents d
  JOIN v3.document_conditions dc ON dc.document_id = d.id
  JOIN v3.conditions c0 ON c0.id = dc.condition_id
  JOIN v3.conditions c ON COALESCE(c.series_id, c.id) = COALESCE(c0.series_id, c0.id)
  JOIN v3.condition_events e ON e.condition_id = c.id
  LEFT JOIN v3.documents x ON x.id = e.document_id
 WHERE d.document_no = :'no'
 GROUP BY e.id, e.condition_id, c.condition_no, c.status, e.event_type, e.occurred_on, e.amount, e.status,
          e.document_id, x.document_no, x.status
 ORDER BY e.condition_id, e.id;

\echo '--- 4. 同じ条件から出た他の文書（下書き・決定・無効・差し替え） ---'
SELECT DISTINCT y.id, y.document_no, y.status, t.template_key AS ひな形, y.issued_at::date AS 決定日, y.supersedes_id
  FROM v3.documents d
  JOIN v3.document_conditions dc ON dc.document_id = d.id
  JOIN v3.conditions c0 ON c0.id = dc.condition_id
  JOIN v3.conditions c ON COALESCE(c.series_id, c.id) = COALESCE(c0.series_id, c0.id)
  JOIN v3.document_conditions dy ON dy.condition_id = c.id
  JOIN v3.documents y ON y.id = dy.document_id
  LEFT JOIN v3.document_template_versions tv ON tv.id = y.template_version_id
  LEFT JOIN v3.document_templates t ON t.id = tv.template_id
 WHERE d.document_no = :'no'
 ORDER BY y.id;
