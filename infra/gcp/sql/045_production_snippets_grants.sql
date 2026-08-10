\set ON_ERROR_STOP on
\pset pager off

-- 045_production_snippets_grants.sql
-- 定型文言（text_snippets・V1 0151）の全社共有化（Phase 16-1）。SELECT/INSERT/UPDATE を付与。
-- 削除は論理削除（is_active=false）＝DELETE は付与しない（V1 と同じ運用）。

\if :{?confirm_snippets}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_snippets=GRANT_PRODUCTION_SNIPPETS'
  \quit 2
\endif

SELECT :'confirm_snippets' = 'GRANT_PRODUCTION_SNIPPETS' AS confirmed
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
  IF to_regclass('public.text_snippets') IS NULL THEN
    RAISE EXCEPTION 'Required relation public.text_snippets is missing (V1 migration 0151)';
  END IF;
END
$guard$;

GRANT CONNECT ON DATABASE legalbridge TO legalbridge_v2_runtime;
GRANT USAGE ON SCHEMA public TO legalbridge_v2_runtime;

GRANT SELECT, INSERT, UPDATE ON public.text_snippets TO legalbridge_v2_runtime;
GRANT USAGE, SELECT ON SEQUENCE public.text_snippets_id_seq TO legalbridge_v2_runtime;

DO $verify$
BEGIN
  IF (
    SELECT count(*) FROM information_schema.role_table_grants
     WHERE grantee = 'legalbridge_v2_runtime' AND table_name = 'text_snippets'
       AND privilege_type IN ('SELECT', 'INSERT', 'UPDATE')
  ) <> 3 THEN
    RAISE EXCEPTION 'text_snippets grants were not applied';
  END IF;
END
$verify$;

COMMIT;
