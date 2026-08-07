\set ON_ERROR_STOP on
\pset pager off

-- 019_gmail_send_history_production_grants.sql
-- 本番(legalbridge)に Gmail 送信の冪等履歴テーブルを作成し、legalbridge_v2_runtime へ
-- SELECT / INSERT を付与する（006 の Slack 履歴と同型・lb_v2_ 接頭辞で隔離・append専用）。
--   UPDATE / DELETE / TRUNCATE は付与しない（履歴は追記のみ）。
--   検証DB用は 019_gmail_send_history_validation.sql（別ファイル）。
-- 前提: 006_production_v2_runtime_foundation.sql 適用済（runtime ロール・CONNECT/USAGE 済）。

\if :{?confirm_gmail_send_history}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_gmail_send_history=GRANT_PRODUCTION_GMAIL_SEND_HISTORY'
  \quit 2
\endif

SELECT :'confirm_gmail_send_history' = 'GRANT_PRODUCTION_GMAIL_SEND_HISTORY' AS confirmed
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

CREATE TABLE IF NOT EXISTS public.lb_v2_gmail_send_history (
  id BIGSERIAL PRIMARY KEY,
  idempotency_key CHAR(64) NOT NULL
    CHECK (idempotency_key ~ '^[a-f0-9]{64}$'),
  document_id BIGINT NOT NULL,
  recipient TEXT NOT NULL,
  gmail_message_id TEXT NOT NULL,
  gmail_thread_id TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by TEXT NOT NULL DEFAULT current_user
);

CREATE UNIQUE INDEX IF NOT EXISTS
  lb_v2_gmail_send_history_idempotency_uq
  ON public.lb_v2_gmail_send_history (idempotency_key);

CREATE INDEX IF NOT EXISTS
  lb_v2_gmail_send_history_document_recorded_idx
  ON public.lb_v2_gmail_send_history (document_id, recorded_at DESC);

COMMENT ON TABLE public.lb_v2_gmail_send_history IS
  'LegalBridge V2 append-only Gmail send history for idempotency in the production business database.';

REVOKE ALL ON TABLE public.lb_v2_gmail_send_history FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.lb_v2_gmail_send_history_id_seq FROM PUBLIC;

GRANT CONNECT ON DATABASE legalbridge TO legalbridge_v2_runtime;
GRANT USAGE ON SCHEMA public TO legalbridge_v2_runtime;

GRANT SELECT, INSERT ON TABLE
  public.lb_v2_gmail_send_history
TO legalbridge_v2_runtime;

GRANT USAGE, SELECT ON SEQUENCE
  public.lb_v2_gmail_send_history_id_seq
TO legalbridge_v2_runtime;

COMMIT;
