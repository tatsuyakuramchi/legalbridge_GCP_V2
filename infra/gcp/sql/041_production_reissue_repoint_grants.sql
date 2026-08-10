\set ON_ERROR_STOP on
\pset pager off

-- 041_production_reissue_repoint_grants.sql
-- 再発行の V1 準拠再設計（S-D・監査 P0-1）に伴う整備：
--   1. condition_events.document_id への列単位 UPDATE を付与
--      （再発行時に有効実績を新版文書へ「付け替える」ため。void 方式は廃止＝残高不変）。
--   2. lb_v2_document_reissue_ledger の canceled_events 列を carried_events へ改名
--      （意味の変更を台帳列名にも反映。既存行の値は「当時 void した件数」として保持される）。
-- 適用後に _DOCUMENT_REISSUE_ENABLED=true / WRITE_SCOPES への document-reissue 復帰が可能になる。
-- 適用前に旧コードが動くことはない（scope 停止中）。

\if :{?confirm_reissue_repoint}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_reissue_repoint=GRANT_PRODUCTION_REISSUE_REPOINT'
  \quit 2
\endif

SELECT :'confirm_reissue_repoint' = 'GRANT_PRODUCTION_REISSUE_REPOINT' AS confirmed
\gset

\if :confirmed
\else
  \echo 'Confirmation value is invalid; no changes were made.'
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
  IF to_regclass('public.lb_v2_document_reissue_ledger') IS NULL THEN
    RAISE EXCEPTION 'Required relation public.lb_v2_document_reissue_ledger is missing (apply 034 first)';
  END IF;
END
$guard$;

GRANT CONNECT ON DATABASE legalbridge TO legalbridge_v2_runtime;
GRANT USAGE ON SCHEMA public TO legalbridge_v2_runtime;

-- 1. 実績の付け替えに必要な列だけを更新可能にする（他列・DELETE は不可のまま）。
GRANT UPDATE (document_id) ON TABLE public.condition_events
TO legalbridge_v2_runtime;

-- 2. 台帳列の改名（冪等：改名済みならスキップ）。
DO $rename$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'lb_v2_document_reissue_ledger'
       AND column_name = 'canceled_events'
  ) THEN
    ALTER TABLE public.lb_v2_document_reissue_ledger
      RENAME COLUMN canceled_events TO carried_events;
  ELSIF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'lb_v2_document_reissue_ledger'
       AND column_name = 'carried_events'
  ) THEN
    RAISE EXCEPTION 'lb_v2_document_reissue_ledger has neither canceled_events nor carried_events';
  END IF;
END
$rename$;

-- 事後検証：GRANT と列名が期待どおりでなければトランザクションごと失敗させる。
DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_column_grants
     WHERE grantee = 'legalbridge_v2_runtime'
       AND table_schema = 'public' AND table_name = 'condition_events'
       AND privilege_type = 'UPDATE' AND column_name = 'document_id'
  ) THEN
    RAISE EXCEPTION 'condition_events.document_id UPDATE grant was not applied';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'lb_v2_document_reissue_ledger'
       AND column_name = 'carried_events'
  ) THEN
    RAISE EXCEPTION 'lb_v2_document_reissue_ledger.carried_events is missing';
  END IF;
END
$verify$;

COMMIT;
