\set ON_ERROR_STOP on
\pset pager off

-- 065_works_ledger_code_remarks.sql
-- 作品詳細500の修復: works テーブルのスキーマドリフト解消。
--   V2 の作品詳細・編集は works.ledger_code / works.remarks を参照するが、
--   この2列を作る DDL が V1・V2 のどのマイグレーションにも存在しなかった
--   （docs/phase2-works-rights-plan.md が存在を前提にしていただけ）。
--   本番では列欠落（42703）が縮退ラップの外のコアクエリで発生し、
--   一覧は開けるのに詳細だけ 500 になる。ADD COLUMN IF NOT EXISTS で冪等に追加する。
--   grant 012 は works へのテーブル単位 SELECT/INSERT/UPDATE のため追加付与は不要。
--
-- 実行: psql "$RUNTIME_ADMIN_DSN" -v confirm_works_columns=ADD_WORKS_LEDGER_CODE_REMARKS \
--         -f infra/gcp/sql/065_works_ledger_code_remarks.sql

\if :{?confirm_works_columns}
\else
  \echo 'Run with: -v confirm_works_columns=ADD_WORKS_LEDGER_CODE_REMARKS'
  \quit 2
\endif
SELECT :'confirm_works_columns' = 'ADD_WORKS_LEDGER_CODE_REMARKS' AS confirmed \gset
\if :confirmed
\else
  \echo 'Confirmation value is invalid; nothing was changed.'
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
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'works'
  ) THEN
    RAISE EXCEPTION 'Table works does not exist';
  END IF;
END
$guard$;

ALTER TABLE public.works ADD COLUMN IF NOT EXISTS ledger_code TEXT;
ALTER TABLE public.works ADD COLUMN IF NOT EXISTS remarks TEXT;

COMMENT ON COLUMN public.works.ledger_code IS
  '台帳コード（既存の紙・Excel台帳の管理番号との照合用・任意）';
COMMENT ON COLUMN public.works.remarks IS '備考（任意）';

SELECT column_name FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'works'
   AND column_name IN ('ledger_code', 'remarks')
 ORDER BY column_name;

COMMIT;
