\set ON_ERROR_STOP on
\pset pager off

-- 010_production_staff_master_grants.sql
-- 担当者(staff)マスタの登録・編集を legalbridge_v2_runtime に許可する最小権限付与。
--   006 で staff の SELECT は付与済み。ここで INSERT, UPDATE のみ追加する
--   （DELETE は付与しない）。非破壊・追加のみ。

\if :{?confirm_staff_master_grants}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_staff_master_grants=GRANT_PRODUCTION_STAFF_MASTER'
  \quit 2
\endif

SELECT :'confirm_staff_master_grants' = 'GRANT_PRODUCTION_STAFF_MASTER' AS confirmed
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
  IF to_regclass('public.staff') IS NULL THEN
    RAISE EXCEPTION 'Relation public.staff is missing';
  END IF;
  IF to_regclass('public.staff_id_seq') IS NULL THEN
    RAISE EXCEPTION 'Sequence public.staff_id_seq is missing';
  END IF;
END
$guard$;

ALTER ROLE legalbridge_v2_runtime
  NOCREATEDB
  NOCREATEROLE;

GRANT CONNECT ON DATABASE legalbridge TO legalbridge_v2_runtime;
GRANT USAGE ON SCHEMA public TO legalbridge_v2_runtime;

GRANT INSERT, UPDATE ON TABLE
  public.staff
TO legalbridge_v2_runtime;

GRANT USAGE, SELECT ON SEQUENCE
  public.staff_id_seq
TO legalbridge_v2_runtime;

COMMIT;
