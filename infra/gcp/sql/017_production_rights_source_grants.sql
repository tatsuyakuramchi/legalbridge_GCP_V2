\set ON_ERROR_STOP on
\pset pager off

-- 017_production_rights_source_grants.sql
-- 権利ソース(material_rights_sources)の編集を legalbridge_v2_runtime に許可する最小権限付与。
--   007 で material_rights_sources の INSERT と _id_seq は付与済み。
--   ここで UPDATE のみ追加する（DELETE は付与しない）。非破壊・追加のみ。

\if :{?confirm_rights_source_grants}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_rights_source_grants=GRANT_PRODUCTION_RIGHTS_SOURCE'
  \quit 2
\endif

SELECT :'confirm_rights_source_grants' = 'GRANT_PRODUCTION_RIGHTS_SOURCE' AS confirmed
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
  IF to_regclass('public.material_rights_sources') IS NULL THEN
    RAISE EXCEPTION 'Relation public.material_rights_sources is missing';
  END IF;
  IF (SELECT relkind FROM pg_class WHERE oid = to_regclass('public.material_rights_sources')) <> 'r' THEN
    RAISE EXCEPTION 'public.material_rights_sources is not an ordinary table';
  END IF;
END
$guard$;

ALTER ROLE legalbridge_v2_runtime
  NOCREATEDB
  NOCREATEROLE;

GRANT CONNECT ON DATABASE legalbridge TO legalbridge_v2_runtime;
GRANT USAGE ON SCHEMA public TO legalbridge_v2_runtime;

-- INSERT と _id_seq は 007 で付与済み。編集用に UPDATE を追加。
GRANT UPDATE ON TABLE
  public.material_rights_sources
TO legalbridge_v2_runtime;

COMMIT;
