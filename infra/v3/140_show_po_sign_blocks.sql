-- =====================================================================
-- 発注書の本文のうち、署名に関わる部分を丸ごと出す（読むだけ）。
--   (1) 冒頭の発注者（自社）の記名・押印のあたり
--   (2) 「■ 通知先」（SHOW_ORDER_SIGN_SECTION）から末尾まで
--   実行: docker compose run --rm ops sql /v3/140_show_po_sign_blocks.sql
--   出力はひな形の本文だけ（相手の実名は含まれない）。
-- =====================================================================
\pset pager off

SELECT '(1) 発注者の記名・押印のあたり' AS 部分,
       substr(v.html_source, greatest(1, strpos(v.html_source, 'PARTY_A_REP') - 900), 1800) AS 本文
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'purchase_order'
UNION ALL
SELECT '(2) 通知先から末尾まで',
       substr(v.html_source, strpos(v.html_source, '<!-- ===== 通知先'), 6000)
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'purchase_order';
