\set ON_ERROR_STOP on
\pset pager off

-- 024_matter_slack_threads_production_preflight.sql
-- 読取専用の事前確認（本番）。変更は行わない（作成/GRANT は 024_matter_slack_threads_production_grants.sql）。

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected production database legalbridge, connected to %', current_database();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legalbridge_v2_runtime') THEN
    RAISE EXCEPTION 'Role legalbridge_v2_runtime does not exist';
  END IF;
  IF to_regclass('public.lb_v2_matter_slack_threads') IS NULL THEN
    RAISE EXCEPTION 'Relation public.lb_v2_matter_slack_threads is missing (run 024_matter_slack_threads_production_grants.sql first)';
  END IF;
END
$guard$;

SELECT
  table_name,
  string_agg(privilege_type, ', ' ORDER BY privilege_type) AS current_privileges
FROM information_schema.role_table_grants
WHERE grantee = 'legalbridge_v2_runtime'
  AND table_schema = 'public'
  AND table_name = 'lb_v2_matter_slack_threads'
GROUP BY table_name
ORDER BY table_name;
