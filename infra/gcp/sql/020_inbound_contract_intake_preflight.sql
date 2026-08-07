\set ON_ERROR_STOP on
\pset pager off

-- 020_inbound_contract_intake_preflight.sql
-- 読取専用の事前確認。変更は行わない（作成/GRANT は 020_inbound_contract_intake_validation.sql 側）。
-- 隔離検証DBで、取込台帳の存在と writer の SELECT/INSERT/UPDATE 権限を確認する。

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge_v2_validation' THEN
    RAISE EXCEPTION 'Expected validation database legalbridge_v2_validation, connected to %', current_database();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legalbridge_v2_validation_writer') THEN
    RAISE EXCEPTION 'Role legalbridge_v2_validation_writer does not exist';
  END IF;
  IF to_regclass('public.lb_v2_inbound_contracts') IS NULL THEN
    RAISE EXCEPTION 'Relation public.lb_v2_inbound_contracts is missing (run 020_inbound_contract_intake_validation.sql first)';
  END IF;
END
$guard$;

SELECT
  table_name,
  string_agg(privilege_type, ', ' ORDER BY privilege_type) AS current_privileges
FROM information_schema.role_table_grants
WHERE grantee = 'legalbridge_v2_validation_writer'
  AND table_schema = 'public'
  AND table_name = 'lb_v2_inbound_contracts'
GROUP BY table_name
ORDER BY table_name;
