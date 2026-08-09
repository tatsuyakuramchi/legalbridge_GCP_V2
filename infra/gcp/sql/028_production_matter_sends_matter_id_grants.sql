\set ON_ERROR_STOP on
\pset pager off

-- 028_production_matter_sends_matter_id_grants.sql
-- 案件マージ（名寄せ）で送信履歴を存続先へ移送するため、document_sends.matter_id の
-- 付け替えを legalbridge_v2_runtime に許可する。
--   対象: document_sends の **列レベル UPDATE(matter_id) のみ**（他列は更新不可＝最小権限）。
--   027 で SELECT, INSERT は付与済み（履歴は追記のみ）。ここでは matter_id 列のみ更新可にし、
--   マージ時の `UPDATE document_sends SET matter_id = target WHERE matter_id = source` を可能にする。
--   行削除は行わない。非破壊・追加のみ。

\if :{?confirm_matter_sends_matter_id}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_matter_sends_matter_id=GRANT_PRODUCTION_MATTER_SENDS_MATTER_ID'
  \quit 2
\endif

SELECT :'confirm_matter_sends_matter_id' = 'GRANT_PRODUCTION_MATTER_SENDS_MATTER_ID' AS confirmed
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
  IF to_regclass('public.document_sends') IS NULL THEN
    RAISE EXCEPTION 'Required relation public.document_sends is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'document_sends' AND column_name = 'matter_id'
  ) THEN
    RAISE EXCEPTION 'Column public.document_sends.matter_id is missing';
  END IF;
END
$guard$;

GRANT CONNECT ON DATABASE legalbridge TO legalbridge_v2_runtime;
GRANT USAGE ON SCHEMA public TO legalbridge_v2_runtime;

-- 名寄せの送信履歴移送に必要な列だけを更新可能にする。
GRANT UPDATE (matter_id) ON TABLE
  public.document_sends
TO legalbridge_v2_runtime;

COMMIT;
