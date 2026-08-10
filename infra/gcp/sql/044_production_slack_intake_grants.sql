\set ON_ERROR_STOP on
\pset pager off

-- 044_production_slack_intake_grants.sql
-- Slack 法務依頼インテーク（Phase 16-3a）の書込を legalbridge_v2_runtime に許可する。
--   1. 隔離受付台帳 lb_v2_slack_intake_ledger を新設（追記専用・dry-run/live の全受付を記録）。
--   2. legal_requests / issue_workflows への INSERT（V1 の依頼レコードと同じ表へ書く）。
--      legal_requests には V1 の AFTER INSERT トリガ（0103_matter_autolink）があり matters /
--      matter_issues が自動生成される。両表の INSERT は Phase 8（案件管理）の grant で付与済み想定
--      — preflight で必ず確認してから適用すること。
--   3. staff / department_workflow_rules の SELECT は既存 grant の範囲（新規付与なし）。
-- DELETE / UPDATE は一切付与しない。

\if :{?confirm_slack_intake}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_slack_intake=GRANT_PRODUCTION_SLACK_INTAKE'
  \quit 2
\endif

SELECT :'confirm_slack_intake' = 'GRANT_PRODUCTION_SLACK_INTAKE' AS confirmed
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
  IF to_regclass('public.legal_requests') IS NULL OR to_regclass('public.issue_workflows') IS NULL THEN
    RAISE EXCEPTION 'Required relations legal_requests/issue_workflows are missing';
  END IF;
  -- legal_requests の AFTER INSERT トリガが生成する matters/matter_issues への INSERT が
  -- 無いとインテークが実行時に 42501 で失敗する。事前条件として検査する。
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
     WHERE grantee = 'legalbridge_v2_runtime' AND table_schema = 'public'
       AND table_name = 'matters' AND privilege_type = 'INSERT'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
     WHERE grantee = 'legalbridge_v2_runtime' AND table_schema = 'public'
       AND table_name = 'matter_issues' AND privilege_type = 'INSERT'
  ) THEN
    RAISE EXCEPTION 'matters/matter_issues INSERT grants are required first (matter autolink trigger on legal_requests)';
  END IF;
END
$guard$;

GRANT CONNECT ON DATABASE legalbridge TO legalbridge_v2_runtime;
GRANT USAGE ON SCHEMA public TO legalbridge_v2_runtime;

-- 1. 隔離受付台帳（追記専用）。
CREATE TABLE IF NOT EXISTS public.lb_v2_slack_intake_ledger (
  id                BIGSERIAL PRIMARY KEY,
  slack_user_id     TEXT NOT NULL,
  request_type      TEXT NOT NULL,
  summary           TEXT NOT NULL,
  backlog_issue_key TEXT,
  mode              TEXT NOT NULL,
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_by       TEXT NOT NULL DEFAULT current_user,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lb_v2_slack_intake_ledger_user_idx
  ON public.lb_v2_slack_intake_ledger (slack_user_id, received_at);
COMMENT ON TABLE public.lb_v2_slack_intake_ledger IS
  'LegalBridge V2 Slack legal-request intake receipts (append-only; records both dry-run and live submissions).';

REVOKE ALL ON public.lb_v2_slack_intake_ledger FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON public.lb_v2_slack_intake_ledger FROM legalbridge_v2_runtime;
GRANT SELECT, INSERT ON public.lb_v2_slack_intake_ledger TO legalbridge_v2_runtime;
GRANT USAGE, SELECT ON SEQUENCE public.lb_v2_slack_intake_ledger_id_seq TO legalbridge_v2_runtime;

-- 2. V1 依頼レコードへの INSERT（読取は既存）。
GRANT SELECT, INSERT ON public.legal_requests TO legalbridge_v2_runtime;
GRANT SELECT, INSERT ON public.issue_workflows TO legalbridge_v2_runtime;

-- SERIAL 主キーのシーケンス（存在するものだけ）。
DO $sequences$
DECLARE
  seq text;
BEGIN
  FOREACH seq IN ARRAY ARRAY['legal_requests_id_seq', 'issue_workflows_id_seq'] LOOP
    IF to_regclass('public.' || seq) IS NOT NULL THEN
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO legalbridge_v2_runtime', seq);
    END IF;
  END LOOP;
END
$sequences$;

-- 事後検証。
DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
     WHERE grantee = 'legalbridge_v2_runtime' AND table_name = 'legal_requests' AND privilege_type = 'INSERT'
  ) THEN
    RAISE EXCEPTION 'legal_requests INSERT grant was not applied';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
     WHERE grantee = 'legalbridge_v2_runtime' AND table_name = 'lb_v2_slack_intake_ledger' AND privilege_type = 'INSERT'
  ) THEN
    RAISE EXCEPTION 'lb_v2_slack_intake_ledger INSERT grant was not applied';
  END IF;
END
$verify$;

COMMIT;
