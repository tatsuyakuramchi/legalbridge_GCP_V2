\set ON_ERROR_STOP on
\pset pager off

-- 016_production_payment_ledger_preflight.sql
-- 読取専用の事前確認。変更は行わない（GRANT は 016_..._grants.sql 側）。
-- Phase 1：受領→入金 / 分配→出金 の payments 台帳同期（SELECT/INSERT/UPDATE）。

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected production database legalbridge, connected to %', current_database();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legalbridge_v2_runtime') THEN
    RAISE EXCEPTION 'Role legalbridge_v2_runtime does not exist';
  END IF;
  IF to_regclass('public.payments') IS NULL THEN
    RAISE EXCEPTION 'Required relation public.payments is missing';
  END IF;
  IF (SELECT relkind FROM pg_class WHERE oid = 'public.payments'::regclass) <> 'r' THEN
    RAISE EXCEPTION 'public.payments is not an ordinary table (relkind <> r)';
  END IF;
END
$guard$;

SELECT
  table_name,
  string_agg(privilege_type, ', ' ORDER BY privilege_type) AS current_privileges
FROM information_schema.role_table_grants
WHERE grantee = 'legalbridge_v2_runtime'
  AND table_schema = 'public'
  AND table_name = 'payments'
GROUP BY table_name
ORDER BY table_name;
