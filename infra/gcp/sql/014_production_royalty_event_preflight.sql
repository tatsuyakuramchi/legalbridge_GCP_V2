\set ON_ERROR_STOP on
\pset pager off

-- 014_production_royalty_event_preflight.sql
-- 読取専用の事前確認。変更は行わない（GRANT は 014_..._grants.sql 側）。
-- Phase 1 スライス2：ロイヤリティ消化イベント（condition_events への INSERT）。

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected production database legalbridge, connected to %', current_database();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legalbridge_v2_runtime') THEN
    RAISE EXCEPTION 'Role legalbridge_v2_runtime does not exist';
  END IF;
  -- 物理テーブルであること（VIEW への誤GRANT防止）。
  IF to_regclass('public.condition_events') IS NULL THEN
    RAISE EXCEPTION 'Required relation public.condition_events is missing';
  END IF;
  IF (SELECT relkind FROM pg_class WHERE oid = 'public.condition_events'::regclass) <> 'r' THEN
    RAISE EXCEPTION 'public.condition_events is not an ordinary table (relkind <> r)';
  END IF;
END
$guard$;

-- 現在の権限（INSERT 付与前の状態を確認）。
SELECT
  table_name,
  string_agg(privilege_type, ', ' ORDER BY privilege_type) AS current_privileges
FROM information_schema.role_table_grants
WHERE grantee = 'legalbridge_v2_runtime'
  AND table_schema = 'public'
  AND table_name = 'condition_events'
GROUP BY table_name
ORDER BY table_name;
