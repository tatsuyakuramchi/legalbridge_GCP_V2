\set ON_ERROR_STOP on
\pset pager off

-- 020_inbound_contract_intake_production_grants.sql
-- 本番(legalbridge)に Gmail 受信取込の登録台帳を作成し、legalbridge_v2_runtime へ
-- SELECT / INSERT / UPDATE を付与する（lb_v2_ 接頭辞で隔離・append＋status遷移）。
--   UPDATE は status 遷移(captured→linked/dismissed)のみ想定。DELETE / TRUNCATE は付与しない。
--   検証DB用は 020_inbound_contract_intake_validation.sql（別ファイル）。
-- 前提: 006_production_v2_runtime_foundation.sql 適用済（runtime ロール・CONNECT/USAGE 済）。

\if :{?confirm_inbound_intake}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_inbound_intake=GRANT_PRODUCTION_INBOUND_INTAKE'
  \quit 2
\endif

SELECT :'confirm_inbound_intake' = 'GRANT_PRODUCTION_INBOUND_INTAKE' AS confirmed
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

CREATE TABLE IF NOT EXISTS public.lb_v2_inbound_contracts (
  id BIGSERIAL PRIMARY KEY,
  idempotency_key CHAR(64) NOT NULL
    CHECK (idempotency_key ~ '^[a-f0-9]{64}$'),
  message_id TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  thread_id TEXT,
  filename TEXT NOT NULL,
  from_address TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  received_at TIMESTAMPTZ,
  drive_link TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'captured'
    CHECK (status IN ('captured', 'linked', 'dismissed')),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  captured_by TEXT NOT NULL DEFAULT current_user
);

CREATE UNIQUE INDEX IF NOT EXISTS
  lb_v2_inbound_contracts_idempotency_uq
  ON public.lb_v2_inbound_contracts (idempotency_key);

CREATE INDEX IF NOT EXISTS
  lb_v2_inbound_contracts_status_captured_idx
  ON public.lb_v2_inbound_contracts (status, captured_at DESC);

COMMENT ON TABLE public.lb_v2_inbound_contracts IS
  'LegalBridge V2 inbound contract intake ledger in the production business database. Append + status transitions only.';

REVOKE ALL ON TABLE public.lb_v2_inbound_contracts FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.lb_v2_inbound_contracts_id_seq FROM PUBLIC;

GRANT CONNECT ON DATABASE legalbridge TO legalbridge_v2_runtime;
GRANT USAGE ON SCHEMA public TO legalbridge_v2_runtime;

GRANT SELECT, INSERT, UPDATE ON TABLE
  public.lb_v2_inbound_contracts
TO legalbridge_v2_runtime;

GRANT USAGE, SELECT ON SEQUENCE
  public.lb_v2_inbound_contracts_id_seq
TO legalbridge_v2_runtime;

COMMIT;
