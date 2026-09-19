-- =====================================================================
-- 検収書のひな形の「今回の納品内容」の表を確かめる（読むだけ）
--
--   007_inspection_order_no.sql（行ごとの発注番号を足す）を流す前に、
--   本番の現行版がどんな並びかを見る。置換の目印がここに出るかで、
--   007 がそのまま通るかが分かる。Cloud SQL Studio にそのまま貼れる。
-- =====================================================================

-- 1. 現行版と、置換の目印の有無
SELECT t.template_key, t.current_version_id, v.version_no,
       strpos(v.html_source, '{{#each delivery_line_items}}') > 0            AS 明細ループあり,
       strpos(v.html_source, '<th style="width:47%">成果物・業務内容</th>') > 0 AS 見出し47pct,
       (length(v.html_source) - length(replace(v.html_source, 'colspan="5"', ''))) / 11 AS colspan5の数,
       strpos(v.html_source, '{{order_no}}') > 0                              AS 発注番号あり,
       (length(v.html_source) - length(replace(v.html_source,
          '<td class="center">{{#if (gt inspected_quantity 0)}}', ''))) / 52     AS 数量セルの数,
       strpos(v.html_source, '<td colspan="5" class="right">検収 小計（税抜）</td>') > 0 AS 小計行,
       strpos(v.html_source, E'<td colspan="5" class="right">\n          消費税(') > 0 AS 消費税行,
       strpos(v.html_source, '<td colspan="5" class="right">源泉徴収税計算前　検収金額(税込)</td>') > 0 AS 税込行
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'inspection_certificate';

-- 2. 明細ループの本文（最初の 1,200 文字）。列の並びが読める。
SELECT substr(v.html_source,
              strpos(v.html_source, '{{#each delivery_line_items}}'), 1200) AS 明細ループ
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'inspection_certificate';

-- 4. 合計行（colspan="5" の 3 箇所の前後）。消費税の行は改行と空白まで一致が要る。
SELECT substr(v.html_source, greatest(1, strpos(v.html_source, 'colspan="5"') - 40), 1000) AS 合計行
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'inspection_certificate';

-- 3. 見出しの行（「成果物・業務内容」の前後 600 文字）
SELECT substr(v.html_source,
              greatest(1, strpos(v.html_source, '成果物・業務内容') - 300), 600) AS 見出し
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'inspection_certificate';
