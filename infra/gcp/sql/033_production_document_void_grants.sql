\set ON_ERROR_STOP on
\pset pager off

-- 033_production_document_void_grants.sql
-- 発行文書の void（無効化・Phase 10-2）を legalbridge_v2_runtime に許可する。V1 と同じく
-- 文書を lifecycle_status='voided'・is_primary=FALSE にし、紐づく有効な実績（condition_events）を
-- 同一トランザクションで取消（voided_at/void_reason）して残高を復元する。
--   対象列: documents(lifecycle_status, is_primary) / condition_events(voided_at, void_reason)。
--   監査は隔離台帳 lb_v2_document_void_ledger（append-only・CREATE＋GRANT 自己完結）へ記録する。
--   本番行そのものは削除しない（状態列の更新のみ）。破壊的（合言葉 COMMIT_DOCUMENT_VOID を実行時に要求）。

\if :{?confirm_document_void}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_document_void=GRANT_PRODUCTION_DOCUMENT_VOID'
  \quit 2
\endif

SELECT :'confirm_document_void' = 'GRANT_PRODUCTION_DOCUMENT_VOID' AS confirmed
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
  IF to_regclass('public.condition_events') IS NULL THEN
    RAISE EXCEPTION 'Required relation public.condition_events is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'documents'
       AND column_name IN ('lifecycle_status', 'is_primary')
     GROUP BY table_name HAVING count(*) = 2
  ) THEN
    RAISE EXCEPTION 'Columns public.documents.(lifecycle_status, is_primary) are missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'condition_events'
       AND column_name IN ('voided_at', 'void_reason')
     GROUP BY table_name HAVING count(*) = 2
  ) THEN
    RAISE EXCEPTION 'Columns public.condition_events.(voided_at, void_reason) are missing';
  END IF;
END
$guard$;

-- 監査台帳（隔離・append-only）。文書 void の実行を記録する。
CREATE TABLE IF NOT EXISTS public.lb_v2_document_void_ledger (
  id               bigserial PRIMARY KEY,
  document_id      integer NOT NULL,
  document_number  text,
  reason           text,
  voided_events    integer NOT NULL DEFAULT 0,
  voided_by        varchar(200) NOT NULL,
  voided_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lb_v2_document_void_ledger_doc
  ON public.lb_v2_document_void_ledger (document_id);

COMMENT ON TABLE public.lb_v2_document_void_ledger IS
  'Phase 10 文書 void の監査台帳（append-only）。';

GRANT CONNECT ON DATABASE legalbridge TO legalbridge_v2_runtime;
GRANT USAGE ON SCHEMA public TO legalbridge_v2_runtime;

-- void に必要な状態列だけを更新可能にする（行削除は許可しない）。
GRANT UPDATE (lifecycle_status, is_primary) ON TABLE
  public.documents
TO legalbridge_v2_runtime;

GRANT UPDATE (voided_at, void_reason) ON TABLE
  public.condition_events
TO legalbridge_v2_runtime;

-- 監査台帳（隔離）は SELECT/INSERT のみ。
REVOKE ALL ON TABLE public.lb_v2_document_void_ledger FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.lb_v2_document_void_ledger_id_seq FROM PUBLIC;

GRANT SELECT, INSERT ON TABLE
  public.lb_v2_document_void_ledger
TO legalbridge_v2_runtime;

GRANT USAGE, SELECT ON SEQUENCE
  public.lb_v2_document_void_ledger_id_seq
TO legalbridge_v2_runtime;

COMMIT;
