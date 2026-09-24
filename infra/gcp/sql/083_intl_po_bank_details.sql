\set ON_ERROR_STOP on
\pset pager off

-- 083_intl_po_bank_details.sql
-- 海外発注書（intl_purchase_order）の Payment Information で、
-- 従来 BANK_NAME だけを表示していた箇所を、海外送金に必要な銀行情報の
-- コンパクト表示へ置換する。
--
-- 重要なレイアウト要件:
--   - 署名欄は 1 ページ目に残す前提。
--   - そのため新しい独立セクション／表は追加せず、既存 BANK_NAME のセル内だけを置換する。
--   - 表示は小さめの文字・詰めた行間・inline 配置にし、通常 2〜3 行程度に収める。
--   - Standard Terms（081）は break-before:page のままなので、本文／署名の後ろに続く。
--
-- 取引先マスタ引用で利用するフィールドは hidden/readonly で field_schema に追加する。
-- 手入力で二重管理せず、vendor_bank_accounts の primary 口座をマスタから引用する。
--
-- 実行:
--   psql "$RUNTIME_ADMIN_DSN" -v ON_ERROR_STOP=1 \
--     -v confirm_intl_po_bank_details=ADD_INTL_PO_BANK_DETAILS \
--     -f infra/gcp/sql/083_intl_po_bank_details.sql

\if :{?confirm_intl_po_bank_details}
\else
  \echo 'Run with: -v confirm_intl_po_bank_details=ADD_INTL_PO_BANK_DETAILS'
  \quit 2
\endif
SELECT :'confirm_intl_po_bank_details' = 'ADD_INTL_PO_BANK_DETAILS' AS confirmed \gset
\if :confirmed
\else
  \echo 'Confirmation value is invalid; nothing was changed.'
  \quit 2
\endif

BEGIN;

DO $do$
DECLARE
  src text;
  schema_json jsonb;
  normalized_schema jsonb;
  new_html text;
  tpl_id bigint;
  next_no int;
  new_id bigint;
  f record;
  bank_token constant text := '{{BANK_NAME}}';
  marker constant text := 'lb-intl-bank-details';
  bank_block constant text := $bank$
<span class="lb-intl-bank-details"
  style="display:block; font-size:7.2pt; line-height:1.18; margin:0; padding:0; break-inside:avoid; page-break-inside:avoid;">
  <span style="font-weight:600;">{{BANK_NAME}}</span>{{#if BRANCH_NAME}} <span>· Branch: {{BRANCH_NAME}}</span>{{/if}}{{#if BANK_COUNTRY}} <span>· Country: {{BANK_COUNTRY}}</span>{{/if}}{{#if BANK_CURRENCY}} <span>· Currency: {{BANK_CURRENCY}}</span>{{/if}}
  {{#if ACCOUNT_HOLDER}}<span> · A/C Name: {{ACCOUNT_HOLDER}}</span>{{/if}}{{#if ACCOUNT_NUMBER}} <span>· A/C No.: {{ACCOUNT_NUMBER}}</span>{{/if}}{{#if IBAN}} <span>· IBAN: {{IBAN}}</span>{{/if}}
  {{#if SWIFT_BIC}}<span> · SWIFT/BIC: {{SWIFT_BIC}}</span>{{/if}}{{#if ROUTING_NUMBER}} <span>· Routing: {{ROUTING_NUMBER}}</span>{{/if}}
  {{#if BANK_ADDRESS}}<span> · Bank Address: {{BANK_ADDRESS}}</span>{{/if}}
  {{#if INTERMEDIARY_BANK_NAME}}<span> · Intermediary: {{INTERMEDIARY_BANK_NAME}}{{#if INTERMEDIARY_BANK_SWIFT}} / {{INTERMEDIARY_BANK_SWIFT}}{{/if}}</span>{{else}}{{#if INTERMEDIARY_BANK_SWIFT}}<span> · Intermediary SWIFT: {{INTERMEDIARY_BANK_SWIFT}}</span>{{/if}}{{/if}}
</span>
$bank$;
BEGIN
  SELECT t.id, v.html_source, v.field_schema
    INTO tpl_id, src, schema_json
    FROM document_templates t
    JOIN document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'intl_purchase_order';

  IF src IS NULL THEN
    RAISE EXCEPTION 'intl_purchase_order template was not found';
  END IF;

  -- DB引用専用の hidden fields。存在する場合も hidden / readonly に正規化する。
  CREATE TEMP TABLE IF NOT EXISTS intl_bank_fields (
    field_name text PRIMARY KEY,
    label text,
    source_column text
  ) ON COMMIT DROP;

  TRUNCATE intl_bank_fields;
  INSERT INTO intl_bank_fields(field_name, label, source_column) VALUES
    ('ACCOUNT_SCOPE', 'Bank Account Scope', 'account_scope'),
    ('BRANCH_NAME', 'Branch', 'branch_name'),
    ('ACCOUNT_NUMBER', 'Account Number', 'account_number'),
    ('ACCOUNT_HOLDER', 'Account Holder', 'account_holder_name'),
    ('SWIFT_BIC', 'SWIFT / BIC', 'swift_bic'),
    ('IBAN', 'IBAN', 'iban'),
    ('ROUTING_NUMBER', 'Routing / ABA / Sort Code', 'routing_number'),
    ('BANK_COUNTRY', 'Bank Country', 'bank_country'),
    ('BANK_ADDRESS', 'Bank Address', 'bank_address'),
    ('BANK_CURRENCY', 'Currency', 'currency'),
    ('INTERMEDIARY_BANK_NAME', 'Intermediary Bank', 'intermediary_bank_name'),
    ('INTERMEDIARY_BANK_SWIFT', 'Intermediary Bank SWIFT', 'intermediary_bank_swift');

  SELECT jsonb_agg(
           CASE
             WHEN f.field_name IS NOT NULL THEN
               e.item || jsonb_build_object(
                 'type', 'hidden',
                 'hidden', true,
                 'readonly', true,
                 'label', f.label,
                 'dbField', 'vendor.' || f.source_column
               )
             ELSE e.item
           END
           ORDER BY e.ord
         )
    INTO normalized_schema
    FROM jsonb_array_elements(schema_json) WITH ORDINALITY AS e(item, ord)
    LEFT JOIN intl_bank_fields f ON f.field_name = e.item->>'name';

  schema_json := COALESCE(normalized_schema, '[]'::jsonb);

  FOR f IN SELECT * FROM intl_bank_fields LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements(schema_json) x
       WHERE x->>'name' = f.field_name
    ) THEN
      schema_json := schema_json || jsonb_build_array(jsonb_build_object(
        'name', f.field_name,
        'label', f.label,
        'type', 'hidden',
        'hidden', true,
        'readonly', true,
        'dbField', 'vendor.' || f.source_column
      ));
    END IF;
  END LOOP;

  IF strpos(src, marker) > 0 THEN
    -- HTML は適用済み。field_schema のみ不足・旧定義を修復する。
    UPDATE document_template_versions v
       SET field_schema = schema_json
      FROM document_templates t
     WHERE t.current_version_id = v.id
       AND t.id = tpl_id;
    RAISE NOTICE 'intl_purchase_order bank details already applied; field schema normalized only';
  ELSE
    IF (length(src) - length(replace(src, bank_token, ''))) / length(bank_token) <> 1 THEN
      RAISE EXCEPTION 'Expected exactly one {{BANK_NAME}} in intl_purchase_order; current template must be inspected before applying 083';
    END IF;

    -- 署名欄の位置を動かさないため、既存セルのトークンだけを置換。
    -- 新しい section/table/page break は作らない。
    new_html := replace(src, bank_token, bank_block);

    -- Standard Terms が既にある場合、その強制改ページは維持されていることを確認。
    IF strpos(src, 'lb-intl-standard-terms') > 0
       AND strpos(new_html, 'break-before:page') = 0
       AND strpos(new_html, 'page-break-before:always') = 0 THEN
      RAISE EXCEPTION 'Standard Terms page-break marker was lost unexpectedly';
    END IF;

    SELECT COALESCE(MAX(version_no), 0) + 1
      INTO next_no
      FROM document_template_versions
     WHERE template_id = tpl_id;

    INSERT INTO document_template_versions
      (template_id, version_no, html_source, field_schema, comment, created_by)
    VALUES
      (tpl_id, next_no, new_html, schema_json,
       'Intl PO: compact overseas bank details inside existing Payment Information cell; preserve first-page signature layout (083)',
       'legalbridge-v2')
    RETURNING id INTO new_id;

    UPDATE document_templates
       SET current_version_id = new_id
     WHERE id = tpl_id;

    RAISE NOTICE 'intl_purchase_order version % created with compact bank details', next_no;
  END IF;
END
$do$;

-- 適用後確認。
SELECT
  t.template_key,
  v.version_no,
  strpos(v.html_source, 'lb-intl-bank-details') > 0 AS has_bank_details,
  strpos(v.html_source, '{{SWIFT_BIC}}') > 0 AS has_swift,
  strpos(v.html_source, '{{IBAN}}') > 0 AS has_iban,
  strpos(v.html_source, '{{ACCOUNT_HOLDER}}') > 0 AS has_account_holder,
  strpos(v.html_source, '{{INTERMEDIARY_BANK_NAME}}') > 0 AS has_intermediary_bank,
  strpos(v.html_source, 'lb-intl-standard-terms') > 0 AS keeps_standard_terms
FROM document_templates t
JOIN document_template_versions v ON v.id = t.current_version_id
WHERE t.template_key = 'intl_purchase_order';

SELECT f->>'name' AS field_name,
       f->>'type' AS field_type,
       f->>'hidden' AS hidden,
       f->>'readonly' AS readonly,
       f->>'dbField' AS db_field
FROM document_templates t
JOIN document_template_versions v ON v.id = t.current_version_id,
LATERAL jsonb_array_elements(v.field_schema) f
WHERE t.template_key = 'intl_purchase_order'
  AND f->>'name' IN (
    'ACCOUNT_SCOPE','BRANCH_NAME','ACCOUNT_NUMBER','ACCOUNT_HOLDER',
    'SWIFT_BIC','IBAN','ROUTING_NUMBER','BANK_COUNTRY','BANK_ADDRESS',
    'BANK_CURRENCY','INTERMEDIARY_BANK_NAME','INTERMEDIARY_BANK_SWIFT'
  )
ORDER BY f->>'name';

COMMIT;
