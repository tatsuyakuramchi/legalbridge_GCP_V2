-- =====================================================================
-- 発注書のひな形の本文（現行版）を、そのままファイルに書き出す（読むだけ）。
--   レイアウトを直す下敷きにする。出るのはひな形の本文だけ（相手の実名は含まれない）。
--   実行: docker compose run --rm ops sql /v3/146_dump_po_template.sql
--   出力: infra/local/dumps/purchase_order.html・intl_purchase_order.html（海外版）・
--         intl_purchase_order.variables.json（海外版の項目）（ops コンテナの /dumps）
-- =====================================================================
\pset pager off
\copy (SELECT v.html_source FROM v3.document_templates t JOIN v3.document_template_versions v ON v.id = t.current_version_id WHERE t.template_key = 'purchase_order') TO '/dumps/purchase_order.html'
\copy (SELECT v.html_source FROM v3.document_templates t JOIN v3.document_template_versions v ON v.id = t.current_version_id WHERE t.template_key = 'terms_spot_2026') TO '/dumps/terms_spot_2026.html'
\copy (SELECT v.html_source FROM v3.document_templates t JOIN v3.document_template_versions v ON v.id = t.current_version_id WHERE t.template_key = 'intl_purchase_order') TO '/dumps/intl_purchase_order.html'
\copy (SELECT jsonb_pretty(v.variables) FROM v3.document_templates t JOIN v3.document_template_versions v ON v.id = t.current_version_id WHERE t.template_key = 'intl_purchase_order') TO '/dumps/intl_purchase_order.variables.json'
SELECT t.template_key AS 書き出したひな形, v.version_no AS 版, length(v.html_source) AS 文字数
  FROM v3.document_templates t JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key IN ('purchase_order', 'terms_spot_2026', 'intl_purchase_order');
