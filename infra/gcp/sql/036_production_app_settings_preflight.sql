\set ON_ERROR_STOP on
\pset pager off

-- 036_production_app_settings_preflight.sql
-- 読取専用の事前確認（本番）。変更なし（GRANT は 036_production_app_settings_grants.sql）。

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected production database legalbridge, connected to %', current_database();
  END IF;
  IF to_regclass('public.app_settings') IS NULL THEN
    RAISE EXCEPTION 'Relation public.app_settings is missing';
  END IF;
END
$guard$;

-- 会社プロファイルの現在値（allowlist キー）。
SELECT key, value
FROM public.app_settings
WHERE key LIKE 'COMPANY_%'
ORDER BY key;

-- 現在の app_settings への権限。
SELECT privilege_type
FROM information_schema.role_table_grants
WHERE grantee = 'legalbridge_v2_runtime'
  AND table_schema = 'public' AND table_name = 'app_settings'
ORDER BY privilege_type;
