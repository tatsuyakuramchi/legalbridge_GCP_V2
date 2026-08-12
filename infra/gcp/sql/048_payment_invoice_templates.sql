\set ON_ERROR_STOP on
\pset pager off

-- 048_payment_invoice_templates.sql
-- 支払通知書（payment_notice / ARC-PAY）・請求書（invoice / ARC-INV）のテンプレート投入（W4）。
-- 入口（発番プレフィックス・record_type・検索同義語・送信パイプライン）はアプリ側で整備済み。
-- 本ファイルを流せば 作成→確定→PDF→Drive→メール/CloudSign まで既存パイプラインで完結する。
-- ★ html_source / field_schema は暫定の最小構成。正式デザイン確定後は
--   document_template_versions に version_no を上げて新版を INSERT し current_version_id を差し替えること。

\if :{?confirm_payment_templates}
\else
  \echo 'Run with: -v confirm_payment_templates=SEED_PAYMENT_INVOICE_TEMPLATES'
  \quit 2
\endif
SELECT :'confirm_payment_templates' = 'SEED_PAYMENT_INVOICE_TEMPLATES' AS confirmed \gset
\if :confirmed
\else
  \echo 'Confirmation value is invalid; nothing was changed.'
  \quit 2
\endif

BEGIN;

-- 既に同キーがあれば二重投入しない
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM document_templates WHERE template_key IN ('payment_notice', 'invoice')) THEN
    RAISE EXCEPTION 'payment_notice / invoice は登録済みです（新版は versions に追加してください）';
  END IF;
END $$;

WITH template AS (
  INSERT INTO document_templates (template_key, kind, label, category, document_prefix)
  VALUES ('payment_notice', 'document', '支払通知書', 'Billing', 'ARC-PAY')
  RETURNING id
)
INSERT INTO document_template_versions (template_id, version_no, html_source, field_schema)
SELECT id, 1,
    '<h1>支払通知書</h1><p>{{VENDOR_NAME}} 御中</p><p>発行日：{{ISSUE_DATE}}</p><p>件名：{{PROJECT_TITLE}}</p><p>お支払金額（税込）：{{TOTAL_AMOUNT}} 円</p><p>お支払期日：{{PAYMENT_DUE_DATE}}</p><p>{{REMARKS}}</p>',
    '[
      {"name":"PROJECT_TITLE","label":"件名","group":"I. 概要","required":true,"dbField":"backlog.summary"},
      {"name":"ISSUE_DATE","label":"発行日","type":"date","group":"I. 概要","required":true,"dbField":"auto.today"},
      {"name":"VENDOR_NAME","label":"支払先名称","group":"II. 支払先","required":true,"dbField":"vendor.vendor_name"},
      {"name":"TOTAL_AMOUNT","label":"支払金額（税込）","type":"number","group":"III. 金額","required":true},
      {"name":"PAYMENT_DUE_DATE","label":"支払期日","type":"date","group":"III. 金額","required":true},
      {"name":"REMARKS","label":"備考","type":"textarea","group":"IV. 備考"}
    ]'::jsonb
FROM template;

-- CTE 内の INSERT 行は同一文の外側 UPDATE から見えないため、差し替えは別文で行う。
UPDATE document_templates t SET current_version_id = v.id
  FROM document_template_versions v
 WHERE t.template_key = 'payment_notice' AND v.template_id = t.id AND v.version_no = 1;

WITH template AS (
  INSERT INTO document_templates (template_key, kind, label, category, document_prefix)
  VALUES ('invoice', 'document', '請求書', 'Billing', 'ARC-INV')
  RETURNING id
)
INSERT INTO document_template_versions (template_id, version_no, html_source, field_schema)
SELECT id, 1,
    '<h1>請求書</h1><p>{{VENDOR_NAME}} 御中</p><p>発行日：{{ISSUE_DATE}}</p><p>件名：{{PROJECT_TITLE}}</p><p>ご請求金額（税込）：{{TOTAL_AMOUNT}} 円</p><p>お支払期日：{{PAYMENT_DUE_DATE}}</p><p>振込先：{{BANK_INFO}}</p><p>登録番号：{{COMPANY_INVOICE_NO}}</p><p>{{REMARKS}}</p>',
    '[
      {"name":"PROJECT_TITLE","label":"件名","group":"I. 概要","required":true,"dbField":"backlog.summary"},
      {"name":"ISSUE_DATE","label":"発行日","type":"date","group":"I. 概要","required":true,"dbField":"auto.today"},
      {"name":"VENDOR_NAME","label":"請求先名称","group":"II. 請求先","required":true,"dbField":"vendor.vendor_name"},
      {"name":"TOTAL_AMOUNT","label":"請求金額（税込）","type":"number","group":"III. 金額","required":true},
      {"name":"PAYMENT_DUE_DATE","label":"支払期日","type":"date","group":"III. 金額","required":true},
      {"name":"BANK_INFO","label":"振込先","group":"III. 金額"},
      {"name":"COMPANY_INVOICE_NO","label":"適格請求書 登録番号","group":"III. 金額"},
      {"name":"REMARKS","label":"備考","type":"textarea","group":"IV. 備考"}
    ]'::jsonb
FROM template;

-- CTE 内の INSERT 行は同一文の外側 UPDATE から見えないため、差し替えは別文で行う。
UPDATE document_templates t SET current_version_id = v.id
  FROM document_template_versions v
 WHERE t.template_key = 'invoice' AND v.template_id = t.id AND v.version_no = 1;

COMMIT;

SELECT template_key, label, document_prefix, current_version_id IS NOT NULL AS ready
  FROM document_templates WHERE template_key IN ('payment_notice', 'invoice');
