\set ON_ERROR_STOP on
\pset pager off

-- 018_production_vendor_merge_preflight.sql
-- 読取専用の事前確認。変更は行わない（GRANT は 018_..._grants.sql 側）。

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
  FOREACH relation_name IN ARRAY ARRAY['condition_lines', 'material_categories', 'contracts', 'contract_works']
  LOOP
    IF to_regclass(format('public.%I', relation_name)) IS NULL THEN
      RAISE EXCEPTION 'Required relation public.% is missing', relation_name;
    END IF;
  END LOOP;
END
$guard$;

-- 現在の列単位UPDATE付与状況を表示（適用後の確認用）。
SELECT table_name, column_name, privilege_type
FROM information_schema.column_privileges
WHERE grantee = 'legalbridge_v2_runtime'
  AND table_schema = 'public'
  AND ((table_name = 'condition_lines' AND column_name = 'counterparty_vendor_id')
    OR (table_name = 'material_categories' AND column_name = 'rights_holder_vendor_id')
    OR (table_name = 'contracts' AND column_name = 'primary_vendor_id')
    OR (table_name = 'contract_works' AND column_name = 'rights_holder_vendor_id'))
ORDER BY table_name, column_name;
