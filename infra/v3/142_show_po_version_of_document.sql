-- =====================================================================
-- 決定済みの発注書が「どの版のひな形」で刷られているかを見る（読むだけ）。
--
--   決定済みの文書は、決定したときの版の本文で描き直す（現行版ではない）。
--   140 で見たのは現行版の本文。古い版では「■ 署名欄（甲・乙）」が
--   SHOW_ORDER_SIGN_SECTION で囲まれていなかった可能性がある。
--
--   実行: docker compose run --rm ops sql /v3/142_show_po_version_of_document.sql q=ARC-PO-2026-1114
--   出力はひな形の本文の断片と版の番号だけ（相手の実名は含まれない）。
-- =====================================================================
\pset pager off
\if :{?q}
\else
\set q ''
\endif

-- 1. 発注書のひな形の版ごとに、署名欄の囲みがあるか
SELECT v.id AS 版id, v.version_no AS 版, v.created_at::date AS 作成日, left(v.comment, 60) AS 注記,
       (v.html_source LIKE '%{{#if SHOW_ORDER_SIGN_SECTION}}%') AS 発注署名欄の囲みあり,
       (v.html_source LIKE '%{{#if SHOW_SIGN_SECTION}}%') AS 承諾署名欄の囲みあり,
       (v.html_source LIKE '%■ 署名欄%') AS 署名欄の見出しあり,
       (t.current_version_id = v.id) AS 現行
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.template_id = t.id
 WHERE t.template_key = 'purchase_order'
 ORDER BY v.version_no;

-- 2. その文書が使っている版と、その版の「■ 署名欄」の直前 300 文字
SELECT d.document_no AS 文書番号, v.version_no AS 版, v.id AS 版id,
       substr(v.html_source, greatest(1, strpos(v.html_source, '■ 署名欄') - 300), 360) AS 署名欄の直前
  FROM v3.documents d
  JOIN v3.document_template_versions v ON v.id = d.template_version_id
 WHERE d.document_no = :'q';

-- 3. 同じ古い版で決定した発注書（直す対象の当たりを付ける）
SELECT v.version_no AS 版, count(*) AS 決定済みの枚数, min(d.document_no) AS 最初, max(d.document_no) AS 最後
  FROM v3.documents d
  JOIN v3.document_template_versions v ON v.id = d.template_version_id
  JOIN v3.document_templates t ON t.id = v.template_id
 WHERE t.template_key = 'purchase_order' AND d.status = 'issued'
 GROUP BY v.version_no ORDER BY v.version_no;
