\set ON_ERROR_STOP on
\pset pager off

-- 031_production_contract_expiry_grants.sql
-- 満了ステータス自動遷移（Phase 9-3・daily-checks）で契約の状態を expired へ更新するため、
-- documents.contract_status の付け替えを legalbridge_v2_runtime に許可する。
--   対象: documents の **列レベル UPDATE(contract_status) のみ**（他列は更新不可＝最小権限）。
--   006 で SELECT/INSERT は付与済み。満了日超過かつ draft/awaiting_signature/executed の行のみ
--   アプリ側で 'expired' に更新する（terminated は早期解約のため触らない）。破壊的だが列限定・状態遷移のみ。

\if :{?confirm_contract_expiry}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_contract_expiry=GRANT_PRODUCTION_CONTRACT_EXPIRY'
  \quit 2
\endif

SELECT :'confirm_contract_expiry' = 'GRANT_PRODUCTION_CONTRACT_EXPIRY' AS confirmed
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
  IF to_regclass('public.documents') IS NULL THEN
    RAISE EXCEPTION 'Required relation public.documents is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'documents' AND column_name = 'contract_status'
  ) THEN
    RAISE EXCEPTION 'Column public.documents.contract_status is missing';
  END IF;
END
$guard$;

GRANT CONNECT ON DATABASE legalbridge TO legalbridge_v2_runtime;
GRANT USAGE ON SCHEMA public TO legalbridge_v2_runtime;

-- 満了自動遷移に必要な列だけを更新可能にする。
GRANT UPDATE (contract_status) ON TABLE
  public.documents
TO legalbridge_v2_runtime;

COMMIT;
