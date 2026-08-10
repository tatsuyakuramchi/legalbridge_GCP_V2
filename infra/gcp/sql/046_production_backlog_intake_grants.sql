\set ON_ERROR_STOP on
\pset pager off

-- 046_production_backlog_intake_grants.sql
-- Backlog Webhook 自動起票（9-7 完成形・BACKLOG_INTAKE_ENABLED）。
-- 課題追加(type=1)の自動取込は grant 044（legal_requests / issue_workflows SELECT,INSERT）で足りるため、
-- 本 grant はワークフロー状態同期（type=2 と「受付済み」遷移）に必要な
-- issue_workflows の列レベル UPDATE（current_status_name / updated_at）のみを追加する。

\if :{?confirm_backlog_intake}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_backlog_intake=GRANT_PRODUCTION_BACKLOG_INTAKE'
  \quit 2
\endif

SELECT :'confirm_backlog_intake' = 'GRANT_PRODUCTION_BACKLOG_INTAKE' AS confirmed
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
  IF to_regclass('public.issue_workflows') IS NULL THEN
    RAISE EXCEPTION 'Required relation public.issue_workflows is missing';
  END IF;
  -- 自動取込の INSERT 経路は grant 044 が前提（未適用なら先に 044 を適用する）。
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
     WHERE grantee = 'legalbridge_v2_runtime' AND table_name = 'legal_requests'
       AND privilege_type = 'INSERT'
  ) THEN
    RAISE EXCEPTION 'Apply 044_production_slack_intake_grants.sql first (legal_requests INSERT is required)';
  END IF;
END
$guard$;

GRANT UPDATE (current_status_name, updated_at)
  ON public.issue_workflows TO legalbridge_v2_runtime;

DO $verify$
BEGIN
  IF (
    SELECT count(*) FROM information_schema.column_privileges
     WHERE grantee = 'legalbridge_v2_runtime' AND table_name = 'issue_workflows'
       AND privilege_type = 'UPDATE'
       AND column_name IN ('current_status_name', 'updated_at')
  ) <> 2 THEN
    RAISE EXCEPTION 'issue_workflows column UPDATE grants were not applied';
  END IF;
END
$verify$;

COMMIT;
