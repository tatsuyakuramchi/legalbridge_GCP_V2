\set ON_ERROR_STOP on
\pset pager off

-- 043_production_vendor_merge_documents_grants.sql
-- 取引先名寄せ（vendor-merge）の付替え対象に documents.vendor_id を追加（監査 P1-3）。
--   documents.vendor_id は 0101 で contract_capabilities を documents に統合した際の実FK。
--   grant 018 の付替え対象から漏れており、名寄せ後も全文書が旧取引先を指したままになる。
--   本ファイルは列単位 UPDATE の付与のみ（vendor-merge スコープ点火前に適用しておく）。

\if :{?confirm_vendor_merge_documents}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_vendor_merge_documents=GRANT_PRODUCTION_VENDOR_MERGE_DOCUMENTS'
  \quit 2
\endif

SELECT :'confirm_vendor_merge_documents' = 'GRANT_PRODUCTION_VENDOR_MERGE_DOCUMENTS' AS confirmed
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
     WHERE table_schema = 'public' AND table_name = 'documents' AND column_name = 'vendor_id'
  ) THEN
    RAISE EXCEPTION 'Expected column documents.vendor_id is missing';
  END IF;
END
$guard$;

GRANT UPDATE (vendor_id) ON TABLE public.documents TO legalbridge_v2_runtime;

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_column_grants
     WHERE grantee = 'legalbridge_v2_runtime'
       AND table_schema = 'public' AND table_name = 'documents'
       AND privilege_type = 'UPDATE' AND column_name = 'vendor_id'
  ) THEN
    RAISE EXCEPTION 'documents.vendor_id UPDATE grant was not applied';
  END IF;
END
$verify$;

COMMIT;
