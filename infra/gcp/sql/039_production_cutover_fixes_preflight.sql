\set ON_ERROR_STOP on
\pset pager off

-- 039_production_cutover_fixes_preflight.sql
-- 読取専用の事前確認（本番）。変更なし（適用は 039_production_cutover_fixes_grants.sql）。
-- 載せ替え監査（docs/cutover-readiness-audit.md）P0-2 / P0-6 / P1-15 の現状把握。

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected production database legalbridge, connected to %', current_database();
  END IF;
  IF to_regclass('public.vendors') IS NULL OR to_regclass('public.documents') IS NULL THEN
    RAISE EXCEPTION 'Required relations vendors/documents are missing';
  END IF;
END
$guard$;

-- P0-2: vendors.is_active の有無（監査では V1 の全 migration に追加が無い＝存在しない想定）。
SELECT
  EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'vendors' AND column_name = 'is_active'
  ) AS vendors_is_active_exists;

-- P0-6: documents への列 UPDATE 権限の現状（updated_at / drive_link が無いはず）。
SELECT column_name, privilege_type
FROM information_schema.role_column_grants
WHERE grantee = 'legalbridge_v2_runtime'
  AND table_schema = 'public' AND table_name = 'documents' AND privilege_type = 'UPDATE'
ORDER BY column_name;

-- P1-15: 追記専用台帳（lb_v2_*）に UPDATE/DELETE が付与されていないことの確認。
--   行が返らない＝追記専用が保たれている。行が返る場合は 039 の REVOKE が是正する。
SELECT table_name, privilege_type
FROM information_schema.role_table_grants
WHERE grantee IN ('legalbridge_v2_runtime', 'PUBLIC')
  AND table_schema = 'public'
  AND table_name IN ('lb_v2_document_void_ledger', 'lb_v2_document_reissue_ledger',
                     'lb_v2_excel_export_ledger', 'lb_v2_webhook_receipts', 'lb_v2_job_alert_ledger')
  AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')
ORDER BY table_name, privilege_type;

-- 参考: vendors の行数（ALTER の影響規模。PG11+ は fast default のため書換は発生しない）。
SELECT count(*) AS vendors_rows FROM public.vendors;
