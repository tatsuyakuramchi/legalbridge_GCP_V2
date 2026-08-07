\set ON_ERROR_STOP on
\pset pager off

-- 022_cloudsign_request_history_production_grants.sql
-- 本番(legalbridge)に CloudSign 依頼の冪等履歴台帳を作成し、legalbridge_v2_runtime へ
-- SELECT / INSERT / UPDATE を付与する（lb_v2_ 接頭辞で隔離・append＋status反映）。
--   UPDATE は締結状況(status)反映のみ想定。DELETE / TRUNCATE は付与しない。
--   検証DB用は 022_cloudsign_request_history_validation.sql（別ファイル）。
-- 前提: 006_production_v2_runtime_foundation.sql 適用済（runtime ロール・CONNECT/USAGE 済）。

\if :{?confirm_cloudsign_history}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_cloudsign_history=GRANT_PRODUCTION_CLOUDSIGN_HISTORY'
  \quit 2
\endif

SELECT :'confirm_cloudsign_history' = 'GRANT_PRODUCTION_CLOUDSIGN_HISTORY' AS confirmed
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

CREATE TABLE IF NOT EXISTS public.lb_v2_cloudsign_requests (
  id BIGSERIAL PRIMARY KEY,
  idempotency_key CHAR(64) NOT NULL
    CHECK (idempotency_key ~ '^[a-f0-9]{64}$'),
  document_id BIGINT NOT NULL,
  cloud_sign_document_id TEXT NOT NULL,
  status TEXT NOT NULL,
  participant_count INTEGER NOT NULL DEFAULT 0,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by TEXT NOT NULL DEFAULT current_user
);

CREATE UNIQUE INDEX IF NOT EXISTS
  lb_v2_cloudsign_requests_idempotency_uq
  ON public.lb_v2_cloudsign_requests (idempotency_key);

CREATE INDEX IF NOT EXISTS
  lb_v2_cloudsign_requests_document_recorded_idx
  ON public.lb_v2_cloudsign_requests (document_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS
  lb_v2_cloudsign_requests_csid_idx
  ON public.lb_v2_cloudsign_requests (cloud_sign_document_id);

COMMENT ON TABLE public.lb_v2_cloudsign_requests IS
  'LegalBridge V2 CloudSign signature-request ledger (idempotency + document-id persistence) in the production business database.';

REVOKE ALL ON TABLE public.lb_v2_cloudsign_requests FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.lb_v2_cloudsign_requests_id_seq FROM PUBLIC;

GRANT CONNECT ON DATABASE legalbridge TO legalbridge_v2_runtime;
GRANT USAGE ON SCHEMA public TO legalbridge_v2_runtime;

GRANT SELECT, INSERT, UPDATE ON TABLE
  public.lb_v2_cloudsign_requests
TO legalbridge_v2_runtime;

GRANT USAGE, SELECT ON SEQUENCE
  public.lb_v2_cloudsign_requests_id_seq
TO legalbridge_v2_runtime;

COMMIT;
