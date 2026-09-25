-- =====================================================================
-- 発注書の署名欄が両方刷られる原因を見分ける（読むだけ）。
--
--   138 で焼き付いた値が 発注署名欄=false・承諾署名欄=true なのに両方出るなら、
--     (a) 本文の出し分けの書き方（{{#if SHOW_ORDER_SIGN_SECTION}} の形でない）
--     (b) 値が真偽値でなく文字列の "false"（本文では空でない文字列は「あり」扱い）
--   のどちらか。1 で本文、2 で値の型を見る。
--
--   実行: docker compose run --rm ops sql /v3/139_show_po_sign_markup.sql
--         docker compose run --rm ops sql /v3/139_show_po_sign_markup.sql q=ARC-PO-2026-1094
--   出力はひな形の本文の断片と値の型だけ（相手の実名は含まれない）。
-- =====================================================================
\pset pager off
\if :{?q}
\else
\set q ''
\endif

-- 1. 本文の出し分け。署名欄の項目名が出てくるところの前後を抜く
SELECT t.template_key AS ひな形, v.version_no AS 版, m[1] AS 本文の断片
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id,
       LATERAL regexp_matches(v.html_source, '(.{0,160}(SHOW_ORDER_SIGN_SECTION|SHOW_SIGN_SECTION).{0,160})', 'g') AS m
 WHERE t.template_key IN ('purchase_order', 'intl_purchase_order')
 ORDER BY 1, 2;

-- 2. 本文にある出し分けの札を、出てくる順に並べる（入れ子の形が分かる）
SELECT t.template_key AS ひな形, m[1] AS 出し分けの札
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id,
       LATERAL regexp_matches(v.html_source, '(\{\{[#/]?(?:if|unless|else)[^}]*\}\})', 'g') AS m
 WHERE t.template_key = 'purchase_order';

-- 3. 焼き付いた値の型。"boolean" なら真偽値、"string" なら文字列（(b) の疑い）
SELECT d.document_no AS 文書番号,
       jsonb_typeof(d.rendered_values -> 'SHOW_ORDER_SIGN_SECTION') AS 発注署名欄の型,
       d.rendered_values ->> 'SHOW_ORDER_SIGN_SECTION' AS 発注署名欄,
       jsonb_typeof(d.rendered_values -> 'SHOW_SIGN_SECTION') AS 承諾署名欄の型,
       d.rendered_values ->> 'SHOW_SIGN_SECTION' AS 承諾署名欄,
       jsonb_typeof(d.manual_inputs -> 'SHOW_ORDER_SIGN_SECTION') AS 手入力の発注署名欄の型
  FROM v3.documents d
  JOIN v3.document_template_versions v ON v.id = d.template_version_id
  JOIN v3.document_templates t ON t.id = v.template_id
 WHERE t.template_key IN ('purchase_order', 'intl_purchase_order') AND d.status = 'issued'
   AND (:'q' = '' OR d.document_no = :'q')
 ORDER BY d.id DESC
 LIMIT 5;
