-- =====================================================================
-- 153 海外発注書の源泉の欄に税率を出す（非居住者と租税条約・A-057）
--
--   海外発注書の約款 6.2・6.4 条：法令で必要なら源泉徴収する。租税条約の軽減・免除は、
--   届出書・居住者証明書が支払日までに届いたときだけ。届かなければ国内法の税率（非居住者は 20.42%）。
--   V3 は取引先の「非居住者」「条約の税率」「書類を受け取った日」から税率の文を組み
--   （withholding_rate_text）、Withholding Tax の欄に出す。税率の文が無い取引先は従来の案内のまま。
--   151 のあとに流す。何度流しても同じ（済んでいれば何もしない）。
--
--   実行: psql -v ON_ERROR_STOP=1 -f infra/v3/153_intl_po_withholding_rate.sql
-- =====================================================================

BEGIN;

DO $do$
DECLARE
  tpl_id bigint;
  from_version bigint;
  from_no int;
  src text;
  new_html text;
  next_no int;
  new_id bigint;
BEGIN
  SELECT t.id, v.id, v.version_no, v.html_source INTO tpl_id, from_version, from_no, src
    FROM v3.document_templates t
    JOIN v3.document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'intl_purchase_order';
  IF src IS NULL THEN
    RAISE EXCEPTION 'intl_purchase_order のひな形が見つかりません';
  END IF;
  IF strpos(src, 'withholding_rate_text') > 0 THEN
    RAISE NOTICE '153: 海外発注書には税率の欄が入っています。何もしません';
    RETURN;
  END IF;
  new_html := replace(src, '{{#if withholding_label}}{{withholding_label}}{{#if (eq withholding_label "Applicable")}} (subject to the applicable tax treaty; a certificate of residency may be requested){{/if}}{{else}}—{{/if}}', '{{#if withholding_label}}{{withholding_label}}{{#if (eq withholding_label "Applicable")}}{{#if withholding_rate_text}} — {{withholding_rate_text}}{{else}} (subject to the applicable tax treaty; a certificate of residency may be requested){{/if}}{{/if}}{{else}}—{{/if}}');
  IF new_html = src THEN
    RAISE EXCEPTION '153: Withholding Tax の欄が見つかりません（148 の版か確かめてください）';
  END IF;
  SELECT COALESCE(max(version_no), 0) + 1 INTO next_no
    FROM v3.document_template_versions WHERE template_id = tpl_id;
  INSERT INTO v3.document_template_versions (template_id, version_no, html_source, variables, comment, created_by)
  SELECT tpl_id, next_no, new_html, v.variables,
         format('153: 源泉の欄に税率（非居住者 20.42%%・租税条約）を出す（%s 版から）', from_no), 'sql:153'
    FROM v3.document_template_versions v WHERE v.id = from_version
  RETURNING id INTO new_id;
  UPDATE v3.document_templates SET current_version_id = new_id WHERE id = tpl_id;
  RAISE NOTICE '153: intl_purchase_order 前の版 id=%（版 %）→ 新しい版 id=%（版 %）', from_version, from_no, new_id, next_no;
END
$do$;

COMMIT;

SELECT t.template_key AS ひな形, v.version_no AS 版,
       (strpos(v.html_source, 'withholding_rate_text') > 0) AS 源泉の税率
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key IN ('intl_purchase_order', 'intl_inspection_certificate')
 ORDER BY 1;
