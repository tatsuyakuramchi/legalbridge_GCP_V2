\set ON_ERROR_STOP on
\pset pager off

-- 037_production_workflow_rules_grants.sql
-- 承認ルート（Phase 11-2）。共有 department_workflow_rules（部門ごとの承認者/押印担当/責任者の
-- Slack ID・部署チャンネル・有効フラグ）への編集を legalbridge_v2_runtime に許可する。
--   upsert（ON CONFLICT (department)）のため SELECT/INSERT/UPDATE。DELETE は付与しない（is_active で無効化）。
--   本テーブルは V1 の通知・承認ルーティングも参照するため V1/V2 で一貫する。V1 既存テーブル＝CREATE しない。

\if :{?confirm_workflow_rules}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_workflow_rules=GRANT_PRODUCTION_WORKFLOW_RULES'
  \quit 2
\endif

SELECT :'confirm_workflow_rules' = 'GRANT_PRODUCTION_WORKFLOW_RULES' AS confirmed
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
  IF to_regclass('public.department_workflow_rules') IS NULL THEN
    RAISE EXCEPTION 'Required relation public.department_workflow_rules is missing';
  END IF;
END
$guard$;

GRANT CONNECT ON DATABASE legalbridge TO legalbridge_v2_runtime;
GRANT USAGE ON SCHEMA public TO legalbridge_v2_runtime;

-- upsert（部門一意）に SELECT/INSERT/UPDATE。DELETE は付与しない。
GRANT SELECT, INSERT, UPDATE ON TABLE
  public.department_workflow_rules
TO legalbridge_v2_runtime;

-- SERIAL の採番に必要なシーケンス権限（新規部門の INSERT 用）。
GRANT USAGE, SELECT ON SEQUENCE
  public.department_workflow_rules_id_seq
TO legalbridge_v2_runtime;

COMMIT;
