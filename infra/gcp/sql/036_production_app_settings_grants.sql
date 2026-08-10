\set ON_ERROR_STOP on
\pset pager off

-- 036_production_app_settings_grants.sql
-- システム設定（Phase 11-1）。共有 app_settings（key VARCHAR PK / value JSONB）への
-- 会社プロファイル編集を legalbridge_v2_runtime に許可する。upsert のため SELECT/INSERT/UPDATE。
--   編集キーはアプリ側で allowlist（会社プロファイルのみ）＝連携トグル/秘密は対象外。
--   本テーブルは V1 も参照するため V1/V2 で自社情報が一貫する。行削除は許可しない。

\if :{?confirm_app_settings}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_app_settings=GRANT_PRODUCTION_APP_SETTINGS'
  \quit 2
\endif

SELECT :'confirm_app_settings' = 'GRANT_PRODUCTION_APP_SETTINGS' AS confirmed
\gset

\if :confirmed
\else
  \echo 'Confirmation value is invalid; no privileges were changed.'
  \quit 2
\endif

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected production database legalbridge, connected to %', current_database();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legalbridge_v2_runtime') THEN
    RAISE EXCEPTION 'Role legalbridge_v2_runtime does not exist';
  END IF;
  IF to_regclass('public.app_settings') IS NULL THEN
    RAISE EXCEPTION 'Required relation public.app_settings is missing';
  END IF;
END
$guard$;

GRANT CONNECT ON DATABASE legalbridge TO legalbridge_v2_runtime;
GRANT USAGE ON SCHEMA public TO legalbridge_v2_runtime;

-- key/value の upsert（ON CONFLICT (key) DO UPDATE）に SELECT/INSERT/UPDATE が必要。
GRANT SELECT, INSERT, UPDATE ON TABLE
  public.app_settings
TO legalbridge_v2_runtime;

COMMIT;
