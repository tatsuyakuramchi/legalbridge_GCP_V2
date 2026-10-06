-- =====================================================================
-- 162_condition_distribution.sql（Cloud Shell の psql / Cloud SQL Studio 用）
--
--   A-070：共著の分配を誰がするか（docs/royalty-shares.md §1）。
--   中身は 004_amend.sql の A-070 と同じ（004 を流し直すなら、こちらは要らない）。
--
--     v3.conditions.distribution
--       direct         … 当社が受取人ごとに直接払う（計算書は受取人ごとに 1 枚）
--       representative … 代表（条件の相手先）が受け取って自分で分配する。取り分は
--                        契約の記録として持つだけで、計算書と支払は相手先 1 件
--       空は direct。
--
--   何度流しても同じ。データは書き換えない。
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = v3, public;

ALTER TABLE v3.conditions ADD COLUMN IF NOT EXISTS distribution text;
DO $a070$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'v3.conditions'::regclass AND conname = 'conditions_distribution_chk') THEN
    ALTER TABLE v3.conditions ADD CONSTRAINT conditions_distribution_chk
      CHECK (distribution IS NULL OR distribution IN ('direct', 'representative'));
  END IF;
END $a070$;
COMMENT ON COLUMN v3.conditions.distribution IS
  '共著の分配を誰がするか。direct=当社が受取人ごとに払う（既定）/ representative=代表（相手先）が分配。A-070';

COMMIT;

-- 確認（2 であること）
SELECT (SELECT count(*) FROM information_schema.columns
         WHERE table_schema='v3' AND table_name='conditions' AND column_name='distribution')
     + (SELECT count(*) FROM pg_constraint
         WHERE conrelid='v3.conditions'::regclass AND conname='conditions_distribution_chk') AS 列とCHECK;
