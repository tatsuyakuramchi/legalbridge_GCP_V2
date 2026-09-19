-- =====================================================================
-- 検収書のひな形の「今回の納品内容」の表より後ろ（注意書き・連絡先・署名など）を
-- 読む（読むだけ）。レイアウト改訂（表を畳んで詳細を下に出す）の前に、
-- 下部に何があるかを確かめる。093 と同じ作法。
--
--   実行: Cloud SQL Studio にそのまま貼る／ローカルは
--         docker compose run --rm ops sql /v3/116_show_inspection_tail.sql
-- =====================================================================

-- 1. 明細ループの本文（{{#each delivery_line_items}} から 2,000 文字）
SELECT substr(v.html_source,
              strpos(v.html_source, '{{#each delivery_line_items}}'), 2000) AS 明細ループ
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'inspection_certificate';

-- 2. 税込の合計行から本文の末尾まで（注意書き・確認方法・連絡先・署名がここに出る）
SELECT substr(v.html_source,
              strpos(v.html_source, '源泉徴収税計算前　検収金額(税込)')) AS 表より後ろ
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'inspection_certificate';

-- 3. 本文の長さと版
SELECT t.template_key, v.version_no, length(v.html_source) AS 文字数,
       strpos(v.html_source, '{{#each delivery_line_items}}') AS ループの位置,
       strpos(v.html_source, '源泉徴収税計算前　検収金額(税込)') AS 合計行の位置
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'inspection_certificate';
