\set ON_ERROR_STOP on
\pset pager off

-- 027_production_matter_sends_grants.sql
-- 案件の文書送信履歴（document_sends）の参照・追記を legalbridge_v2_runtime に許可する。
--   対象: document_sends の SELECT, INSERT と対応 sequence（append専用・履歴）。
--   006 では未付与。UPDATE / DELETE は付与しない（履歴は追記のみ）。非破壊・追加のみ。

\if :{?confirm_matter_sends}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_matter_sends=GRANT_PRODUCTION_MATTER_SENDS'
  \quit 2
\endif

SELECT :'confirm_matter_sends' = 'GRANT_PRODUCTION_MATTER_SENDS' AS confirmed
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
  IF (SELECT relkind FROM pg_class WHERE oid = 'public.document_sends'::regclass) <> 'r' THEN
    RAISE EXCEPTION 'public.document_sends is not an ordinary table (relkind <> r)';
  END IF;
END
$guard$;

GRANT CONNECT ON DATABASE legalbridge TO legalbridge_v2_runtime;
GRANT USAGE ON SCHEMA public TO legalbridge_v2_runtime;

-- 送信履歴の参照・追記（append専用）。
GRANT SELECT, INSERT ON TABLE
  public.document_sends
TO legalbridge_v2_runtime;

GRANT USAGE, SELECT ON SEQUENCE
  public.document_sends_id_seq
TO legalbridge_v2_runtime;

COMMIT;
