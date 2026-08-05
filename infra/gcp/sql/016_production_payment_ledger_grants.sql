\set ON_ERROR_STOP on
\pset pager off

-- 016_production_payment_ledger_grants.sql
-- 受領→入金 / 分配→出金 の台帳同期に必要な権限を legalbridge_v2_runtime へ付与。
--   対象: payments の SELECT / INSERT / UPDATE。
--   DELETE は付与しない（クリアは金額ゼロUPDATEで運用・no-DELETE不変条件）。
--   非破壊・追加のみ。

\if :{?confirm_payment_ledger_grants}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_payment_ledger_grants=GRANT_PRODUCTION_PAYMENT_LEDGER'
  \quit 2
\endif

SELECT :'confirm_payment_ledger_grants' = 'GRANT_PRODUCTION_PAYMENT_LEDGER' AS confirmed
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
  IF to_regclass('public.payments') IS NULL THEN
    RAISE EXCEPTION 'Required relation public.payments is missing';
  END IF;
  IF (SELECT relkind FROM pg_class WHERE oid = 'public.payments'::regclass) <> 'r' THEN
    RAISE EXCEPTION 'public.payments is not an ordinary table (relkind <> r)';
  END IF;
END
$guard$;

ALTER ROLE legalbridge_v2_runtime
  NOCREATEDB
  NOCREATEROLE;

GRANT CONNECT ON DATABASE legalbridge TO legalbridge_v2_runtime;
GRANT USAGE ON SCHEMA public TO legalbridge_v2_runtime;

-- 入金・出金台帳の参照・作成・更新。DELETE は付与しない。
GRANT SELECT, INSERT, UPDATE ON TABLE
  public.payments
TO legalbridge_v2_runtime;

-- SERIAL 主キーの採番に必要。
GRANT USAGE, SELECT ON SEQUENCE
  public.payments_id_seq
TO legalbridge_v2_runtime;

COMMIT;
