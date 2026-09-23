-- =====================================================================
-- ひな形の本文で、登録番号（T 番号）をどう差しているかを見る（読むだけ）。
--   「T{{INVOICE_REGISTRATION_NUMBER}}」のように本文に T が書いてあると、
--   台帳の値（T 付き）と重なって「TT…」になる。
--   実行: docker compose run --rm ops sql /v3/144_show_invoice_no_markup.sql
--   出力はひな形の本文の断片だけ。
-- =====================================================================
\pset pager off
SELECT t.template_key AS ひな形, v.version_no AS 版, m[1] AS 本文の断片
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id,
       LATERAL regexp_matches(v.html_source,
         '(.{0,80}\{\{(INVOICE_REGISTRATION_NUMBER|VENDOR_INVOICE_NO|COMPANY_INVOICE_NO|licensor_t_number|T番号|登録番号|許諾者登録番号|被許諾者登録番号)\}\}.{0,40})', 'g') AS m
 WHERE t.is_active
 ORDER BY 1, 2;
