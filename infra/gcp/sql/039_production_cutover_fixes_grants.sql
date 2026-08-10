\set ON_ERROR_STOP on
\pset pager off

-- 039_production_cutover_fixes_grants.sql
-- 載せ替え監査（docs/cutover-readiness-audit.md）で検出したスキーマ/GRANT の欠落を是正する。
--   P0-2 : vendors.is_active 列を追加（V1 スキーマに存在しないが V2 の取引先 無効化/名寄せ が参照）。
--          既定 TRUE・NOT NULL。PG11+ の fast default のためテーブル書換は発生しない。
--          UPDATE 権限は grant 009 のテーブルレベル UPDATE が新列にも及ぶため追加 GRANT 不要。
--   P0-6 : documents の updated_at / drive_link に列単位 UPDATE を付与
--          （CloudSign executed 遷移・満了ジョブ・Drive リンク添付が SET する列。未付与だと 42501）。
--   P1-15: 追記専用台帳 lb_v2_*（void/reissue/excel/webhook/job-alert）から UPDATE/DELETE/TRUNCATE を
--          明示 REVOKE（現状も未付与のはずだが、追記専用の不変条件を宣言として固定する）。
-- 既存データの変更・削除は行わない。

\if :{?confirm_cutover_fixes}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_cutover_fixes=GRANT_PRODUCTION_CUTOVER_FIXES'
  \quit 2
\endif

SELECT :'confirm_cutover_fixes' = 'GRANT_PRODUCTION_CUTOVER_FIXES' AS confirmed
\gset

\if :confirmed
\else
  \echo 'Confirmation value is invalid; no changes were made.'
  \quit 2
\endif

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected production database legalbridge, connected to %', current_database();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legalbridge_v2_runtime') THEN
    RAISE EXCEPTION 'Role legalbridge_v2_runtime does not exist';
  END IF;
  IF to_regclass('public.vendors') IS NULL THEN
    RAISE EXCEPTION 'Required relation public.vendors is missing';
  END IF;
  IF to_regclass('public.documents') IS NULL THEN
    RAISE EXCEPTION 'Required relation public.documents is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'documents'
       AND column_name IN ('updated_at', 'drive_link')
     GROUP BY table_name HAVING count(*) = 2
  ) THEN
    RAISE EXCEPTION 'Expected columns updated_at/drive_link are missing on public.documents';
  END IF;
END
$guard$;

GRANT CONNECT ON DATABASE legalbridge TO legalbridge_v2_runtime;
GRANT USAGE ON SCHEMA public TO legalbridge_v2_runtime;

-- P0-2: 取引先の論理削除列。既存行は既定 TRUE（全件有効のまま）。
ALTER TABLE public.vendors
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

-- P0-6: documents の運用列に列単位 UPDATE（行削除・他列更新は不可のまま）。
GRANT UPDATE (updated_at, drive_link) ON TABLE public.documents
TO legalbridge_v2_runtime;

-- P1-15: 追記専用台帳の不変条件を明示（未付与でも冪等）。
--   台帳は 030/032〜035 の適用順に依存して存在するため、実在するものだけに REVOKE する。
DO $ledgers$
DECLARE
  ledger text;
BEGIN
  FOREACH ledger IN ARRAY ARRAY[
    'lb_v2_document_void_ledger', 'lb_v2_document_reissue_ledger',
    'lb_v2_excel_export_ledger', 'lb_v2_webhook_receipts', 'lb_v2_job_alert_ledger'
  ] LOOP
    IF to_regclass('public.' || ledger) IS NOT NULL THEN
      EXECUTE format(
        'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.%I FROM legalbridge_v2_runtime, PUBLIC',
        ledger
      );
    ELSE
      RAISE NOTICE 'Skipping append-only revoke: public.% does not exist yet', ledger;
    END IF;
  END LOOP;
END
$ledgers$;

-- 事後検証：列とGRANTが期待どおりでなければトランザクションごと失敗させる。
DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'vendors' AND column_name = 'is_active'
  ) THEN
    RAISE EXCEPTION 'vendors.is_active was not created';
  END IF;
  IF (
    SELECT count(*) FROM information_schema.role_column_grants
     WHERE grantee = 'legalbridge_v2_runtime'
       AND table_schema = 'public' AND table_name = 'documents'
       AND privilege_type = 'UPDATE' AND column_name IN ('updated_at', 'drive_link')
  ) <> 2 THEN
    RAISE EXCEPTION 'documents.updated_at/drive_link UPDATE grants were not applied';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
     WHERE grantee IN ('legalbridge_v2_runtime', 'PUBLIC')
       AND table_schema = 'public'
       AND table_name IN ('lb_v2_document_void_ledger', 'lb_v2_document_reissue_ledger',
                          'lb_v2_excel_export_ledger', 'lb_v2_webhook_receipts', 'lb_v2_job_alert_ledger')
       AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')
  ) THEN
    RAISE EXCEPTION 'Append-only ledgers still carry UPDATE/DELETE/TRUNCATE grants';
  END IF;
END
$verify$;

COMMIT;
