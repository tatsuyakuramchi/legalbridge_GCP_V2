\set ON_ERROR_STOP on
\pset pager off

-- 070_works_business_line.sql
-- 作品に「展開区分」（business_line: game / publishing / both）を追加する
-- （利用者承認 2026-09-02）。作品登録・編集・作品詳細から作る文書の種類
-- （ゲーム＝個別利用許諾条件書V3／出版＝出版個別利用許諾条件書・出版基本契約）を
-- この区分で絞る。値の検証はアプリ側（zod enum）で行い、NULL＝未設定（旧作品）を許す。
-- grant 012 は works へのテーブル単位 SELECT/INSERT/UPDATE のため追加付与は不要。
--
-- 実行: psql "$RUNTIME_ADMIN_DSN" -v confirm_business_line=ADD_WORKS_BUSINESS_LINE \
--         -f infra/gcp/sql/070_works_business_line.sql

\if :{?confirm_business_line}
\else
  \echo 'Run with: -v confirm_business_line=ADD_WORKS_BUSINESS_LINE'
  \quit 2
\endif
SELECT :'confirm_business_line' = 'ADD_WORKS_BUSINESS_LINE' AS confirmed \gset
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
END
$guard$;

ALTER TABLE public.works ADD COLUMN IF NOT EXISTS business_line TEXT;
COMMENT ON COLUMN public.works.business_line IS
  '展開区分: game=ゲーム / publishing=出版 / both=両方（NULL=未設定）。作品から作る条件書の種類を絞る';

SELECT column_name FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'works' AND column_name = 'business_line';

COMMIT;
