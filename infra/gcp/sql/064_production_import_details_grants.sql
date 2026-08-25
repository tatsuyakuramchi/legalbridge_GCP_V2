\set ON_ERROR_STOP on
\pset pager off

-- 064_production_import_details_grants.sql
-- 取込文書（過去文書・template_version_id IS NULL）の詳細編集に必要な列単位 UPDATE。
--   過去文書をベースに検収書・利用許諾料計算書を作るため、取込後に form_data
--   （発注明細・経費・手数料・金銭条件・振込先など）を編集できるようにする。
--   生成された文書は対象外（アプリ層で template_version_id IS NULL に限定して UPDATE）。
--   updated_at の UPDATE は 039 で付与済み。

\if :{?confirm_import_details}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_import_details=GRANT_PRODUCTION_IMPORT_DETAILS'
  \quit 2
\endif

SELECT :'confirm_import_details' = 'GRANT_PRODUCTION_IMPORT_DETAILS' AS confirmed
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
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'documents' AND column_name = 'form_data'
  ) THEN
    RAISE EXCEPTION 'Expected column documents.form_data is missing';
  END IF;
END
$guard$;

GRANT UPDATE (form_data) ON TABLE public.documents TO legalbridge_v2_runtime;

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_column_grants
     WHERE grantee = 'legalbridge_v2_runtime'
       AND table_schema = 'public' AND table_name = 'documents'
       AND privilege_type = 'UPDATE' AND column_name = 'form_data'
  ) THEN
    RAISE EXCEPTION 'documents.form_data UPDATE grant was not applied';
  END IF;
END
$verify$;

COMMIT;
