\set ON_ERROR_STOP on
\pset pager off

-- 013_production_material_master_grants.sql
-- 原作マテリアル(work_materials)マスタの編集を legalbridge_v2_runtime に許可する最小権限付与。
--   007 で work_materials / material_categories の INSERT と各 _id_seq は付与済み。
--   ここで work_materials の UPDATE のみ追加する（DELETE は付与しない）。非破壊・追加のみ。

\if :{?confirm_material_master_grants}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_material_master_grants=GRANT_PRODUCTION_MATERIAL_MASTER'
  \quit 2
\endif

SELECT :'confirm_material_master_grants' = 'GRANT_PRODUCTION_MATERIAL_MASTER' AS confirmed
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
  IF to_regclass('public.work_materials') IS NULL THEN
    RAISE EXCEPTION 'Relation public.work_materials is missing';
  END IF;
END
$guard$;

ALTER ROLE legalbridge_v2_runtime
  NOCREATEDB
  NOCREATEROLE;

GRANT CONNECT ON DATABASE legalbridge TO legalbridge_v2_runtime;
GRANT USAGE ON SCHEMA public TO legalbridge_v2_runtime;

-- INSERT と _id_seq は 007 で付与済み。編集用に work_materials の UPDATE を追加。
GRANT UPDATE ON TABLE
  public.work_materials
TO legalbridge_v2_runtime;

COMMIT;
