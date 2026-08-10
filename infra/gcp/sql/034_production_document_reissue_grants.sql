\set ON_ERROR_STOP on
\pset pager off

-- 034_production_document_reissue_grants.sql
-- 文書の再発行（Phase 10-1b）を legalbridge_v2_runtime に許可する。既存の確定文書を基に
-- 新しい版を採番（<base>-R<n>）して INSERT し、旧版を lifecycle_status='reissued'・
-- is_primary=FALSE・superseded_by=<新番号> に倒す。二重計上を避けるため旧版に紐づく
-- 有効実績（condition_events）を同一トランザクションで取消（voided_at/void_reason）する。
--   INSERT ON documents は 006（表レベル）で既付与。UPDATE は列レベルで最小化：
--     documents(lifecycle_status, is_primary, superseded_by) / condition_events(voided_at, void_reason)。
--   監査は隔離台帳 lb_v2_document_reissue_ledger（append-only・CREATE＋GRANT 自己完結）。
--   破壊的（合言葉 COMMIT_DOCUMENT_REISSUE を実行時に要求）。行削除は行わない。

\if :{?confirm_document_reissue}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_document_reissue=GRANT_PRODUCTION_DOCUMENT_REISSUE'
  \quit 2
\endif

SELECT :'confirm_document_reissue' = 'GRANT_PRODUCTION_DOCUMENT_REISSUE' AS confirmed
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
       AND column_name IN ('lifecycle_status', 'is_primary', 'superseded_by', 'base_document_number')
     GROUP BY table_name HAVING count(*) = 4
  ) THEN
    RAISE EXCEPTION 'Columns public.documents.(lifecycle_status, is_primary, superseded_by, base_document_number) are missing';
  END IF;
END
$guard$;

-- 監査台帳（隔離・append-only）。再発行の実行を記録する。
CREATE TABLE IF NOT EXISTS public.lb_v2_document_reissue_ledger (
  id                bigserial PRIMARY KEY,
  source_id         integer NOT NULL,
  source_number     text,
  new_id            integer NOT NULL,
  new_number        text NOT NULL,
  base_number       text,
  canceled_events   integer NOT NULL DEFAULT 0,
  reason            text,
  reissued_by       varchar(200) NOT NULL,
  reissued_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lb_v2_document_reissue_ledger_source
  ON public.lb_v2_document_reissue_ledger (source_id);

COMMENT ON TABLE public.lb_v2_document_reissue_ledger IS
  'Phase 10 文書再発行の監査台帳（append-only）。';

GRANT CONNECT ON DATABASE legalbridge TO legalbridge_v2_runtime;
GRANT USAGE ON SCHEMA public TO legalbridge_v2_runtime;

-- 再発行に必要な状態列のみ更新可能にする（INSERT は 006 の表レベルで既付与）。
GRANT UPDATE (lifecycle_status, is_primary, superseded_by) ON TABLE
  public.documents
TO legalbridge_v2_runtime;

-- 旧版実績の取消（033 と同一・再掲＝冪等）。
GRANT UPDATE (voided_at, void_reason) ON TABLE
  public.condition_events
TO legalbridge_v2_runtime;

REVOKE ALL ON TABLE public.lb_v2_document_reissue_ledger FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.lb_v2_document_reissue_ledger_id_seq FROM PUBLIC;

GRANT SELECT, INSERT ON TABLE
  public.lb_v2_document_reissue_ledger
TO legalbridge_v2_runtime;

GRANT USAGE, SELECT ON SEQUENCE
  public.lb_v2_document_reissue_ledger_id_seq
TO legalbridge_v2_runtime;

COMMIT;
