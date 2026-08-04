\set ON_ERROR_STOP on
\pset pager off

-- 011_production_condition_settlement_grants.sql
-- 条件明細の消化実績・検収率の算出に必要な読取権限を legalbridge_v2_runtime へ付与。
--   対象: condition_line_installments（予定回） / condition_events（実績イベント）の SELECT のみ。
--   書込みは付与しない。非破壊・追加のみ。

\if :{?confirm_condition_settlement_grants}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_condition_settlement_grants=GRANT_PRODUCTION_CONDITION_SETTLEMENT'
  \quit 2
\endif

SELECT :'confirm_condition_settlement_grants' = 'GRANT_PRODUCTION_CONDITION_SETTLEMENT' AS confirmed
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

ALTER ROLE legalbridge_v2_runtime
  NOCREATEDB
  NOCREATEROLE;

GRANT CONNECT ON DATABASE legalbridge TO legalbridge_v2_runtime;
GRANT USAGE ON SCHEMA public TO legalbridge_v2_runtime;

-- 読取のみ（消化・残高・検収率の算出）。
GRANT SELECT ON TABLE
  public.condition_line_installments,
  public.condition_events
TO legalbridge_v2_runtime;

COMMIT;
