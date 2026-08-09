\set ON_ERROR_STOP on
\pset pager off

-- 029_production_matter_delete_grants.sql
-- 案件・タスクの削除（破壊的）を legalbridge_v2_runtime に許可する。
--   対象: matters, matter_tasks の DELETE。
--   案件削除は FK の参照アクションで
--     matter_issues / matter_tasks (ON DELETE CASCADE) を自動削除し、
--     documents.matter_id / document_sends.matter_id (ON DELETE SET NULL) を自動解除する。
--   参照アクションは PostgreSQL 内部で実行されるため、削除実行ロールには当該参照先表への
--   権限は不要（matters への DELETE のみで連鎖する）。タスク単体削除に matter_tasks の DELETE を用いる。
--   本番文書（documents / document_sends）の行そのものは削除しない（SET NULL で解除のみ）。破壊的・削除。

\if :{?confirm_matter_delete}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_matter_delete=GRANT_PRODUCTION_MATTER_DELETE'
  \quit 2
\endif

SELECT :'confirm_matter_delete' = 'GRANT_PRODUCTION_MATTER_DELETE' AS confirmed
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
  IF to_regclass('public.matters') IS NULL THEN
    RAISE EXCEPTION 'Required relation public.matters is missing';
  END IF;
  IF to_regclass('public.matter_tasks') IS NULL THEN
    RAISE EXCEPTION 'Required relation public.matter_tasks is missing';
  END IF;
END
$guard$;

GRANT CONNECT ON DATABASE legalbridge TO legalbridge_v2_runtime;
GRANT USAGE ON SCHEMA public TO legalbridge_v2_runtime;

-- 案件削除（連鎖）とタスク単体削除。
GRANT DELETE ON TABLE
  public.matters,
  public.matter_tasks
TO legalbridge_v2_runtime;

COMMIT;
