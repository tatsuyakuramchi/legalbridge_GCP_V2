\set ON_ERROR_STOP on
\pset pager off

-- 038_production_contract_master_grants.sql
-- 契約マスタの更新・状態変更（Phase 11-4）を legalbridge_v2_runtime に許可する。登録(INSERT)は
-- contract-intake が担うため、ここでは既存 contracts 行の更新（中核フィールド＋ライフサイクル状態）
-- に必要な列単位 UPDATE のみを付与する。全列 UPDATE・DELETE は付与しない（非破壊）。
--   対象列: lifecycle_stage, contract_status, contract_title, effective_date, expiration_date,
--           auto_renewal, renewal_notice_months, alert_lead_months, review_due_date。
--   SELECT は既存（006/intake）で付与済み。primary_vendor_id は名寄せ(018)で別途付与済み。

\if :{?confirm_contract_master}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_contract_master=GRANT_PRODUCTION_CONTRACT_MASTER'
  \quit 2
\endif

SELECT :'confirm_contract_master' = 'GRANT_PRODUCTION_CONTRACT_MASTER' AS confirmed
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
  IF to_regclass('public.contracts') IS NULL THEN
    RAISE EXCEPTION 'Required relation public.contracts is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'contracts'
       AND column_name IN ('lifecycle_stage', 'contract_status', 'contract_title',
                           'effective_date', 'expiration_date', 'auto_renewal',
                           'renewal_notice_months', 'alert_lead_months', 'review_due_date')
     GROUP BY table_name HAVING count(*) = 9
  ) THEN
    RAISE EXCEPTION 'Expected contract master columns are missing on public.contracts';
  END IF;
END
$guard$;

GRANT CONNECT ON DATABASE legalbridge TO legalbridge_v2_runtime;
GRANT USAGE ON SCHEMA public TO legalbridge_v2_runtime;

-- 契約マスタ更新に必要な列だけを更新可能にする（行削除・全列更新は不可）。
GRANT UPDATE (
  lifecycle_stage, contract_status, contract_title,
  effective_date, expiration_date, auto_renewal,
  renewal_notice_months, alert_lead_months, review_due_date
) ON TABLE public.contracts
TO legalbridge_v2_runtime;

COMMIT;
