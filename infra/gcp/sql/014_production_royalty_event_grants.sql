\set ON_ERROR_STOP on
\pset pager off

-- 014_production_royalty_event_grants.sql
-- ロイヤリティ消化イベントの記録に必要な書込み権限を legalbridge_v2_runtime へ付与。
--   対象: condition_events（実績イベント）の INSERT。
--   前提: 011 で condition_events の SELECT は付与済み。本ファイルは INSERT を上乗せする。
--   DELETE は付与しない（論理取消は voided_at 運用・別スライス）。非破壊・追加のみ。

\if :{?confirm_royalty_event_grants}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_royalty_event_grants=GRANT_PRODUCTION_ROYALTY_EVENTS'
  \quit 2
\endif

SELECT :'confirm_royalty_event_grants' = 'GRANT_PRODUCTION_ROYALTY_EVENTS' AS confirmed
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
  IF to_regclass('public.condition_events') IS NULL THEN
    RAISE EXCEPTION 'Required relation public.condition_events is missing';
  END IF;
  -- 物理テーブルであること（VIEW への誤GRANT防止）。
  IF (SELECT relkind FROM pg_class WHERE oid = 'public.condition_events'::regclass) <> 'r' THEN
    RAISE EXCEPTION 'public.condition_events is not an ordinary table (relkind <> r)';
  END IF;
END
$guard$;

ALTER ROLE legalbridge_v2_runtime
  NOCREATEDB
  NOCREATEROLE;

GRANT CONNECT ON DATABASE legalbridge TO legalbridge_v2_runtime;
GRANT USAGE ON SCHEMA public TO legalbridge_v2_runtime;

-- 実績イベントの追記（消化・MG/AG記録）。DELETE は付与しない。
GRANT SELECT, INSERT ON TABLE
  public.condition_events
TO legalbridge_v2_runtime;

-- SERIAL 主キーの採番に必要。
GRANT USAGE, SELECT ON SEQUENCE
  public.condition_events_id_seq
TO legalbridge_v2_runtime;

COMMIT;
