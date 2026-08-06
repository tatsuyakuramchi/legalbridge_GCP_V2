\set ON_ERROR_STOP on
\pset pager off

-- 017_production_rights_source_preflight.sql
-- 読取専用の事前確認。変更は行わない（GRANT は 017_..._grants.sql 側）。

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected production database legalbridge, connected to %', current_database();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legalbridge_v2_runtime') THEN
    RAISE EXCEPTION 'Role legalbridge_v2_runtime does not exist';
  END IF;
  IF to_regclass('public.material_rights_sources') IS NULL THEN
    RAISE EXCEPTION 'Relation public.material_rights_sources is missing';
  END IF;
END
$guard$;

SELECT
  table_name,
  string_agg(privilege_type, ', ' ORDER BY privilege_type) AS current_privileges
FROM information_schema.role_table_grants
WHERE grantee = 'legalbridge_v2_runtime'
  AND table_schema = 'public'
  AND table_name = 'material_rights_sources'
GROUP BY table_name
ORDER BY table_name;
