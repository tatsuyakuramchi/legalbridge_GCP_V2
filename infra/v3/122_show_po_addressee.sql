-- =====================================================================
-- 発注書のひな形の「宛名」と「署名欄」（読むだけ）。A-032 で取引先に代表者
-- （肩書・氏名）を持たせたので、宛名・署名欄に「代表取締役 ◯◯」を出す改訂
-- （123 予定）を書くために、今の markup と差している変数を確かめる。
--   実行: Cloud SQL Studio にそのまま貼る／ローカルは
--         docker compose run --rm ops sql /v3/122_show_po_addressee.sql
-- 出力に取引先の実名は含まれない（ひな形の markup だけ）。
-- =====================================================================
\pset pager off

-- 宛名：VENDOR_NAME（受託者名）の周り
SELECT t.template_key, v.version_no,
       substr(v.html_source, greatest(1, strpos(v.html_source, 'VENDOR_NAME') - 500), 1200) AS 宛名の周り
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key IN ('purchase_order', 'inspection_certificate')
 ORDER BY t.template_key;

-- 署名欄：「署名」「記名」「押印」「signature」のいずれかが最初に出る所の周り
SELECT t.template_key, v.version_no,
       substr(v.html_source,
              greatest(1, (SELECT min(p) FROM unnest(ARRAY[
                 nullif(strpos(v.html_source, '署名'), 0), nullif(strpos(v.html_source, '記名'), 0),
                 nullif(strpos(v.html_source, '押印'), 0), nullif(strpos(v.html_source, 'signature'), 0)]) AS p) - 400),
              1600) AS 署名欄の周り
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key IN ('purchase_order', 'inspection_certificate')
 ORDER BY t.template_key;

-- 代表者・署名者に関わる変数名だけ抜き出す
SELECT t.template_key, m[1] AS 変数
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id,
       LATERAL regexp_matches(v.html_source,
         '(\{\{[^}]*(?:REP|Rep|rep|代表|署名|SIGN|sign|VENDOR_NAME|VENDOR_SUFFIX|IS_CORPORATION)[^}]*\}\})', 'g') AS m
 WHERE t.template_key IN ('purchase_order', 'inspection_certificate')
 GROUP BY t.template_key, m[1] ORDER BY 1, 2;
