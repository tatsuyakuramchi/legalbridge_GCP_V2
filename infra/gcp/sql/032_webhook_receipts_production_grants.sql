\set ON_ERROR_STOP on
\pset pager off

-- 032_webhook_receipts_production_grants.sql
-- 外部 Webhook（CloudSign/Backlog・Phase 9-5/9-7）のべき等台帳。再送されるイベントを
-- (source, external_id) で一意記録し、副作用（契約状態遷移・通知）を初回のみ実行する。
--   CREATE TABLE IF NOT EXISTS ＋ GRANT を自己完結で行う（冪等）。SELECT/INSERT のみ。
--   検証DB用は 032_webhook_receipts_validation.sql（本番では使わない）。

\if :{?confirm_webhook_receipts}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_webhook_receipts=GRANT_PRODUCTION_WEBHOOK_RECEIPTS'
  \quit 2
\endif

SELECT :'confirm_webhook_receipts' = 'GRANT_PRODUCTION_WEBHOOK_RECEIPTS' AS confirmed
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
END
$guard$;

CREATE TABLE IF NOT EXISTS public.lb_v2_webhook_receipts (
  id           bigserial PRIMARY KEY,
  source       varchar(20) NOT NULL,    -- cloudsign / backlog
  external_id  varchar(200) NOT NULL,   -- ソース内でイベントを一意化するキー
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS lb_v2_webhook_receipts_uq
  ON public.lb_v2_webhook_receipts (source, external_id);

COMMENT ON TABLE public.lb_v2_webhook_receipts IS
  'Phase 9 外部 Webhook のべき等台帳（(source, external_id) 一意）。';

REVOKE ALL ON TABLE public.lb_v2_webhook_receipts FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.lb_v2_webhook_receipts_id_seq FROM PUBLIC;

GRANT CONNECT ON DATABASE legalbridge TO legalbridge_v2_runtime;
GRANT USAGE ON SCHEMA public TO legalbridge_v2_runtime;

GRANT SELECT, INSERT ON TABLE
  public.lb_v2_webhook_receipts
TO legalbridge_v2_runtime;

GRANT USAGE, SELECT ON SEQUENCE
  public.lb_v2_webhook_receipts_id_seq
TO legalbridge_v2_runtime;

COMMIT;
