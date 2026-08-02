\set ON_ERROR_STOP on
\pset pager off

-- 008_production_matter_management_grants.sql
-- 案件（matter）作成・編集を legalbridge_v2_runtime に許可する最小権限付与。
--   対象: matters / matter_tasks の INSERT, UPDATE と対応 sequence。
--   006 で SELECT は付与済み。ここで INSERT, UPDATE のみ追加する（DELETE は付与しない）。
--   非破壊・追加のみ。既存の付与は変更しない。

\if :{?confirm_matter_management_grants}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_matter_management_grants=GRANT_PRODUCTION_MATTER_MANAGEMENT'
  \quit 2
\endif

SELECT :'confirm_matter_management_grants' = 'GRANT_PRODUCTION_MATTER_MANAGEMENT' AS confirmed
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

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'legalbridge_v2_runtime'
  ) THEN
    RAISE EXCEPTION 'Role legalbridge_v2_runtime does not exist';
  END IF;

  FOREACH relation_name IN ARRAY ARRAY[
    'matters',
    'matter_tasks'
  ]
  LOOP
    IF to_regclass(format('public.%I', relation_name)) IS NULL THEN
      RAISE EXCEPTION 'Required matter-management relation public.% is missing', relation_name;
    END IF;
  END LOOP;

  FOREACH relation_name IN ARRAY ARRAY[
    'matters_id_seq',
    'matter_tasks_id_seq'
  ]
  LOOP
    IF to_regclass(format('public.%I', relation_name)) IS NULL THEN
      RAISE EXCEPTION 'Required matter-management sequence public.% is missing', relation_name;
    END IF;
  END LOOP;
END
$guard$;

ALTER ROLE legalbridge_v2_runtime
  NOCREATEDB
  NOCREATEROLE;

GRANT CONNECT ON DATABASE legalbridge TO legalbridge_v2_runtime;
GRANT USAGE ON SCHEMA public TO legalbridge_v2_runtime;

-- 案件・タスクの作成/編集。SELECT は 006 で付与済み。
GRANT INSERT, UPDATE ON TABLE
  public.matters,
  public.matter_tasks
TO legalbridge_v2_runtime;

GRANT USAGE, SELECT ON SEQUENCE
  public.matters_id_seq,
  public.matter_tasks_id_seq
TO legalbridge_v2_runtime;

COMMIT;
