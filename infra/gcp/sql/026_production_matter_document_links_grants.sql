\set ON_ERROR_STOP on
\pset pager off

-- 026_production_matter_document_links_grants.sql
-- 案件⇄文書のリンク付け替え（documents.matter_id）を legalbridge_v2_runtime に許可する。
--   対象: documents の **列レベル UPDATE(matter_id) のみ**（他列は更新不可＝最小権限）。
--   006 で SELECT, INSERT は付与済み。リンク=SET matter_id、解除=SET matter_id=NULL。
--   文書行の削除は行わない（付け替えのみ）。非破壊・追加のみ。

\if :{?confirm_matter_document_links}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_matter_document_links=GRANT_PRODUCTION_MATTER_DOCUMENT_LINKS'
  \quit 2
\endif

SELECT :'confirm_matter_document_links' = 'GRANT_PRODUCTION_MATTER_DOCUMENT_LINKS' AS confirmed
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
  IF to_regclass('public.documents') IS NULL THEN
    RAISE EXCEPTION 'Required relation public.documents is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'documents' AND column_name = 'matter_id'
  ) THEN
    RAISE EXCEPTION 'Column public.documents.matter_id is missing';
  END IF;
END
$guard$;

GRANT CONNECT ON DATABASE legalbridge TO legalbridge_v2_runtime;
GRANT USAGE ON SCHEMA public TO legalbridge_v2_runtime;

-- 案件リンクの付け替えに必要な列だけを更新可能にする。
GRANT UPDATE (matter_id) ON TABLE
  public.documents
TO legalbridge_v2_runtime;

COMMIT;
