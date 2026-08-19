\set ON_ERROR_STOP on
\pset pager off

-- 061_intl_po_subscription_billing_note.sql
-- 海外発注書（intl_purchase_order）テンプレ改訂: サブスク明細の Payment Date に
-- 任意設定（billing_note・英文自由記述）を追加する。
--   ・billing_note があればそのまま印字し、無ければ従来どおり自動の支払日表記
--     （billingDayLabelEn: day N of each month 等）、それも無ければ TBD（後方互換）。
--   ・現行版への文字列置換で新版を INSERT し current_version_id を差し替え。
--     置換対象が想定どおり見つからないときは何もせず中断。field_schema は引き継ぐ。
--   ・確定済み文書は自分の版で再生成されるため影響なし。
--
-- 実行: psql "$RUNTIME_ADMIN_DSN" -v confirm_intl_billing_note=ADD_INTL_PO_BILLING_NOTE \
--         -f infra/gcp/sql/061_intl_po_subscription_billing_note.sql

\if :{?confirm_intl_billing_note}
\else
  \echo 'Run with: -v confirm_intl_billing_note=ADD_INTL_PO_BILLING_NOTE'
  \quit 2
\endif
SELECT :'confirm_intl_billing_note' = 'ADD_INTL_PO_BILLING_NOTE' AS confirmed \gset
\if :confirmed
\else
  \echo 'Confirmation value is invalid; nothing was changed.'
  \quit 2
\endif

BEGIN;

DO $do$
DECLARE
  src text;
  new_html text;
  tpl_id bigint;
  next_no int;
  new_id bigint;
  old_block constant text := $q${{#if (eq calc_method "SUBSCRIPTION")}}{{or (billingDayLabelEn billing_day cycle billing_timing) "TBD"}}{{else}}$q$;
  new_block constant text := $q${{#if (eq calc_method "SUBSCRIPTION")}}{{#if billing_note}}{{billing_note}}{{else}}{{or (billingDayLabelEn billing_day cycle billing_timing) "TBD"}}{{/if}}{{else}}$q$;
BEGIN
  SELECT t.id, v.html_source INTO tpl_id, src
    FROM document_templates t
    JOIN document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'intl_purchase_order';
  IF src IS NULL THEN
    RAISE EXCEPTION 'intl_purchase_order テンプレートが見つかりません';
  END IF;
  IF strpos(src, 'billing_note') > 0 THEN
    RAISE EXCEPTION 'billing_note は既に存在します（適用済み）。中断しました';
  END IF;
  IF (length(src) - length(replace(src, old_block, ''))) / length(old_block) <> 1 THEN
    RAISE EXCEPTION 'サブスクの Payment Date 分岐が想定どおり 1 箇所で見つかりません。現行版の内容を確認してください';
  END IF;

  new_html := replace(src, old_block, new_block);

  SELECT COALESCE(MAX(version_no), 0) + 1 INTO next_no
    FROM document_template_versions WHERE template_id = tpl_id;

  INSERT INTO document_template_versions (template_id, version_no, html_source, field_schema, comment, created_by)
  SELECT tpl_id, next_no, new_html, v.field_schema,
         '海外発注書テンプレ改訂: サブスク Payment Date の任意設定 billing_note を追加（061）',
         'legalbridge-v2'
    FROM document_templates t
    JOIN document_template_versions v ON v.id = t.current_version_id
   WHERE t.id = tpl_id
  RETURNING id INTO new_id;

  UPDATE document_templates SET current_version_id = new_id WHERE id = tpl_id;
END
$do$;

SELECT t.template_key, t.current_version_id, v.version_no,
       strpos(v.html_source, 'billing_note') > 0 AS has_billing_note
  FROM document_templates t
  JOIN document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'intl_purchase_order';

COMMIT;
