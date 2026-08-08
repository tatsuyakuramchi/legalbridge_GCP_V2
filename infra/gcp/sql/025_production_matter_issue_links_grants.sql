\set ON_ERROR_STOP on
\pset pager off

-- 025_production_matter_issue_links_grants.sql
-- 案件⇄Backlog課題の紐付け（matter_issues）編集を legalbridge_v2_runtime に許可する。
--   対象: matter_issues の INSERT, UPDATE, DELETE と対応 sequence。
--   006 で SELECT は付与済み。attach は UPSERT（INSERT+UPDATE）、detach は DELETE。
--   matter_issues は link テーブル（matters ON DELETE CASCADE）で、DELETE は紐付け解除のみ。
--   非破壊・追加のみ（既存付与は変更しない）。

\if :{?confirm_matter_issue_links}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_matter_issue_links=GRANT_PRODUCTION_MATTER_ISSUE_LINKS'
  \quit 2
\endif

SELECT :'confirm_matter_issue_links' = 'GRANT_PRODUCTION_MATTER_ISSUE_LINKS' AS confirmed
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
  IF to_regclass('public.matter_issues') IS NULL THEN
    RAISE EXCEPTION 'Required relation public.matter_issues is missing';
  END IF;
  IF (SELECT relkind FROM pg_class WHERE oid = 'public.matter_issues'::regclass) <> 'r' THEN
    RAISE EXCEPTION 'public.matter_issues is not an ordinary table (relkind <> r)';
  END IF;
END
$guard$;

GRANT CONNECT ON DATABASE legalbridge TO legalbridge_v2_runtime;
GRANT USAGE ON SCHEMA public TO legalbridge_v2_runtime;

-- 課題紐付けの追加・更新・解除。
GRANT INSERT, UPDATE, DELETE ON TABLE
  public.matter_issues
TO legalbridge_v2_runtime;

GRANT USAGE, SELECT ON SEQUENCE
  public.matter_issues_id_seq
TO legalbridge_v2_runtime;

COMMIT;
