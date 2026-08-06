\set ON_ERROR_STOP on
\pset pager off

-- 018_production_vendor_merge_grants.sql
-- 取引先マージ（名寄せ）で参照FKを旧→新へ再指定するための最小権限付与。
--   既に UPDATE 済: payments(016) / works(012) / work_materials(013) /
--     material_rights_sources(017) / vendors(009・is_active)。
--   ここでは未付与の4表について、対象の取引先FK列だけを列単位で UPDATE 付与する
--   （全列UPDATEはしない）。DELETE は付与しない。非破壊・追加のみ。

\if :{?confirm_vendor_merge_grants}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_vendor_merge_grants=GRANT_PRODUCTION_VENDOR_MERGE'
  \quit 2
\endif

SELECT :'confirm_vendor_merge_grants' = 'GRANT_PRODUCTION_VENDOR_MERGE' AS confirmed
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
  FOREACH relation_name IN ARRAY ARRAY['condition_lines', 'material_categories', 'contracts', 'contract_works']
  LOOP
    IF to_regclass(format('public.%I', relation_name)) IS NULL THEN
      RAISE EXCEPTION 'Required relation public.% is missing', relation_name;
    END IF;
    IF (SELECT relkind FROM pg_class WHERE oid = to_regclass(format('public.%I', relation_name))) <> 'r' THEN
      RAISE EXCEPTION 'public.% is not an ordinary table', relation_name;
    END IF;
  END LOOP;
END
$guard$;

ALTER ROLE legalbridge_v2_runtime
  NOCREATEDB
  NOCREATEROLE;

GRANT CONNECT ON DATABASE legalbridge TO legalbridge_v2_runtime;
GRANT USAGE ON SCHEMA public TO legalbridge_v2_runtime;

-- 列単位UPDATE（該当の取引先FK列のみ）。他列は更新できない。
GRANT UPDATE (counterparty_vendor_id) ON TABLE public.condition_lines TO legalbridge_v2_runtime;
GRANT UPDATE (rights_holder_vendor_id) ON TABLE public.material_categories TO legalbridge_v2_runtime;
GRANT UPDATE (primary_vendor_id) ON TABLE public.contracts TO legalbridge_v2_runtime;
GRANT UPDATE (rights_holder_vendor_id) ON TABLE public.contract_works TO legalbridge_v2_runtime;

COMMIT;
