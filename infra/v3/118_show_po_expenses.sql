-- =====================================================================
-- 発注書のひな形の「経費」の表（読むだけ）。経費合計が 0 と出る原因を見るため、
-- 経費の行と合計がどの変数を差しているかを確かめる。
--   実行: Cloud SQL Studio にそのまま貼る／ローカルは
--         docker compose run --rm ops sql /v3/118_show_po_expenses.sql
-- =====================================================================
\pset pager off
SELECT t.template_key, v.version_no,
       substr(v.html_source, greatest(1, strpos(v.html_source, '{{#each expenses}}') - 400), 1600) AS 経費の表
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key IN ('purchase_order', 'inspection_certificate')
 ORDER BY t.template_key;

-- 合計の変数名だけ抜き出す（{{…}} のうち Total / total / 合計 を含むもの）
SELECT t.template_key, m[1] AS 変数
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id,
       LATERAL regexp_matches(v.html_source, '(\{\{[^}]*(?:Total|total|expenses)[^}]*\}\})', 'g') AS m
 WHERE t.template_key = 'purchase_order'
 GROUP BY t.template_key, m[1] ORDER BY 2;
