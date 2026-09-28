-- =====================================================================
-- 154 海外発注書：受注者の名前・住所・メールを入力欄の値で出す（通知先にメールが出なかった）
--
--   海外発注書の入力欄は V1 の名前（CONTRACTOR_NAME・CONTRACTOR_ADDRESS・CONTRACTOR_EMAIL）で、
--   148 で作り直した本文は国内版の名前（VENDOR_*）を差していた。取引先マスタに無い値
--   （メール・住所）を欄に入れても本文に出ず、NOTICES の「To the Contractor」にメールが出なかった
--   （約款 18 条の通知先）。入力欄の値を先に、無ければ取引先マスタの値を出す。
--   何度流しても同じ（済んでいれば何もしない）。
--
--   実行: psql -v ON_ERROR_STOP=1 -f infra/v3/154_intl_po_contractor_fields.sql
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
  IF strpos(src, 'CONTRACTOR_EMAIL') > 0 THEN
    RAISE NOTICE '154: 海外発注書は受注者の入力欄を読んでいます。何もしません';
    RETURN;
  END IF;
  new_html := src;
  new_html := replace(new_html, '{{#if VENDOR_ADDRESS}}', '{{#if (or CONTRACTOR_ADDRESS VENDOR_ADDRESS)}}');
  new_html := replace(new_html, '{{VENDOR_ADDRESS}}', '{{or CONTRACTOR_ADDRESS VENDOR_ADDRESS}}');
  new_html := replace(new_html, '{{#if VENDOR_EMAIL}}', '{{#if (or CONTRACTOR_EMAIL VENDOR_EMAIL)}}');
  new_html := replace(new_html, '{{VENDOR_EMAIL}}', '{{or CONTRACTOR_EMAIL VENDOR_EMAIL}}');
  new_html := replace(new_html, '{{VENDOR_NAME}}', '{{or CONTRACTOR_NAME VENDOR_NAME}}');
  IF new_html = src THEN
    RAISE EXCEPTION '154: 受注者の欄が見つかりません（148 の版か確かめてください）';
  END IF;
  SELECT COALESCE(max(version_no), 0) + 1 INTO next_no
    FROM v3.document_template_versions WHERE template_id = tpl_id;
  INSERT INTO v3.document_template_versions (template_id, version_no, html_source, variables, comment, created_by)
  SELECT tpl_id, next_no, new_html, v.variables,
         format('154: 受注者の名前・住所・メールを入力欄（CONTRACTOR_*）から出す（%s 版から）', from_no), 'sql:154'
    FROM v3.document_template_versions v WHERE v.id = from_version
  RETURNING id INTO new_id;
  UPDATE v3.document_templates SET current_version_id = new_id WHERE id = tpl_id;
  RAISE NOTICE '154: intl_purchase_order 前の版 id=%（版 %）→ 新しい版 id=%（版 %）', from_version, from_no, new_id, next_no;
END
$do$;

COMMIT;

-- 確認：入力欄の名前（受注者のメールが通知先に出るか）
SELECT t.template_key AS ひな形, v.version_no AS 版,
       (strpos(v.html_source, 'or CONTRACTOR_EMAIL VENDOR_EMAIL') > 0) AS 通知先のメール,
       (SELECT string_agg(e->>'name', ', ') FROM jsonb_array_elements(v.variables) e
         WHERE e->>'name' ILIKE '%contractor%' OR e->>'label' ILIKE '%contractor%') AS 受注者の入力欄
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'intl_purchase_order';
