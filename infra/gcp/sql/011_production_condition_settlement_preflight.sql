\set ON_ERROR_STOP on
\pset pager off

-- 011_production_condition_settlement_preflight.sql
-- 読取専用の事前確認。変更は行わない（GRANT は 011_..._grants.sql 側）。

DO $guard$
DECLARE
  relation_name text;
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected production database legalbridge, connected to %', current_database();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legalbridge_v2_runtime') THEN
    RAISE EXCEPTION 'Role legalbridge_v2_runtime does not exist';
  END IF;
  FOREACH relation_name IN ARRAY ARRAY['condition_line_installments', 'condition_events']
  LOOP
    IF to_regclass(format('public.%I', relation_name)) IS NULL THEN
      RAISE EXCEPTION 'Required settlement relation public.% is missing', relation_name;
    END IF;
  END LOOP;
END
$guard$;

SELECT
  table_name,
  string_agg(privilege_type, ', ' ORDER BY privilege_type) AS current_privileges
FROM information_schema.role_table_grants
WHERE grantee = 'legalbridge_v2_runtime'
  AND table_schema = 'public'
  AND table_name IN ('condition_line_installments', 'condition_events')
GROUP BY table_name
ORDER BY table_name;
