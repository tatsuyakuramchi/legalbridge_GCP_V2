\set ON_ERROR_STOP on
\pset pager off

-- 019_gmail_send_history_production_preflight.sql
-- 読取専用の事前確認。変更は行わない（作成/GRANT は 019_gmail_send_history_production_grants.sql）。
-- 本番(legalbridge)で、履歴テーブルの存在と runtime の SELECT/INSERT 権限を確認する。

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected production database legalbridge, connected to %', current_database();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legalbridge_v2_runtime') THEN
    RAISE EXCEPTION 'Role legalbridge_v2_runtime does not exist';
  END IF;
  IF to_regclass('public.lb_v2_gmail_send_history') IS NULL THEN
    RAISE EXCEPTION 'Relation public.lb_v2_gmail_send_history is missing (run 019_gmail_send_history_production_grants.sql first)';
  END IF;
END
$guard$;

SELECT
  table_name,
  string_agg(privilege_type, ', ' ORDER BY privilege_type) AS current_privileges
FROM information_schema.role_table_grants
WHERE grantee = 'legalbridge_v2_runtime'
  AND table_schema = 'public'
  AND table_name = 'lb_v2_gmail_send_history'
GROUP BY table_name
ORDER BY table_name;
