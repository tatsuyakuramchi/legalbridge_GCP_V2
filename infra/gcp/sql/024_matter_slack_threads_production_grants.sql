\set ON_ERROR_STOP on
\pset pager off

-- 024_matter_slack_threads_production_grants.sql
-- 本番(legalbridge)に案件 Slack スレッドの隔離テーブルを作成し、legalbridge_v2_runtime へ
-- SELECT / INSERT を付与する（lb_v2_ 接頭辞・1案件1スレッド・UPDATE/DELETE/TRUNCATE 無し）。
--   検証DB用は 024_matter_slack_threads_validation.sql（別ファイル）。
-- 前提: 006_production_v2_runtime_foundation.sql 適用済（runtime ロール・CONNECT/USAGE 済）。

\if :{?confirm_matter_slack_threads}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_matter_slack_threads=GRANT_PRODUCTION_MATTER_SLACK_THREADS'
  \quit 2
\endif

SELECT :'confirm_matter_slack_threads' = 'GRANT_PRODUCTION_MATTER_SLACK_THREADS' AS confirmed
\gset

\if :confirmed
\else
  \echo 'Confirmation value is invalid; no schema or privileges were changed.'
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
    RAISE EXCEPTION 'Role legalbridge_v2_runtime does not exist (run 006 foundation first)';
  END IF;
END
$guard$;

CREATE TABLE IF NOT EXISTS public.lb_v2_matter_slack_threads (
  id BIGSERIAL PRIMARY KEY,
  matter_id BIGINT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  root_text TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT current_user,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS
  lb_v2_matter_slack_threads_matter_uq
  ON public.lb_v2_matter_slack_threads (matter_id);

COMMENT ON TABLE public.lb_v2_matter_slack_threads IS
  'LegalBridge V2 per-matter Slack (legal-consult) thread pointer in the production business database; one thread per matter.';

REVOKE ALL ON TABLE public.lb_v2_matter_slack_threads FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.lb_v2_matter_slack_threads_id_seq FROM PUBLIC;

GRANT CONNECT ON DATABASE legalbridge TO legalbridge_v2_runtime;
GRANT USAGE ON SCHEMA public TO legalbridge_v2_runtime;

GRANT SELECT, INSERT ON TABLE
  public.lb_v2_matter_slack_threads
TO legalbridge_v2_runtime;

GRANT USAGE, SELECT ON SEQUENCE
  public.lb_v2_matter_slack_threads_id_seq
TO legalbridge_v2_runtime;

COMMIT;
