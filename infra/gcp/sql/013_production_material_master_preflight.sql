\set ON_ERROR_STOP on
\pset pager off

-- 013_production_material_master_preflight.sql
-- 読取専用の事前確認。変更は行わない（GRANT は 013_..._grants.sql 側）。

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected production database legalbridge, connected to %', current_database();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legalbridge_v2_runtime') THEN
    RAISE EXCEPTION 'Role legalbridge_v2_runtime does not exist';
  END IF;
  IF to_regclass('public.work_materials') IS NULL THEN
    RAISE EXCEPTION 'Relation public.work_materials is missing';
  END IF;
  IF to_regclass('public.material_categories') IS NULL THEN
    RAISE EXCEPTION 'Relation public.material_categories is missing';
  END IF;
END
$guard$;

SELECT
  table_name,
  string_agg(privilege_type, ', ' ORDER BY privilege_type) AS current_privileges
FROM information_schema.role_table_grants
WHERE grantee = 'legalbridge_v2_runtime'
  AND table_schema = 'public'
  AND table_name IN ('work_materials', 'material_categories')
GROUP BY table_name
ORDER BY table_name;
