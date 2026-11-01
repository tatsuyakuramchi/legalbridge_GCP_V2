-- =====================================================================
-- 196_work_source_title.sql（Cloud Shell の psql / Cloud SQL Studio 用）
--
--   作品の原作名（原著作物名）。docs/work-editions.md §8。
--
--   原作と作品は表裏一体で、名前だけが違うことがある（海外原題 → 日本語版名 など）。
--   これまでは名前を変えるために原作を別の作品（種別 原作）として立て、系譜で繋いでいた。
--   原作名を作品の項目の 1 つとして持つ：
--     works.source_title … 原作名。空なら作品名と同じ（原作を兼ねる）
--   利用許諾計算書の件名「◯◯ 利用許諾料のご報告」（原著作物名）はこれを出し、明細の製品名は作品名のまま。
--
--   既存の表に列を足すだけなので、実行ロールの権限は表の権限がそのまま効く。
--   何度流しても同じ結果。戻すときは 196_work_source_title_rollback.sql。
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = v3, public;

ALTER TABLE v3.works ADD COLUMN IF NOT EXISTS source_title text;
COMMENT ON COLUMN v3.works.source_title IS
  '原作名（原著作物名）。空なら作品名と同じ。利用許諾計算書の件名（原著作物名）に出る。明細の製品名は作品名のまま。';

COMMIT;

-- 確かめ：列がある
SELECT column_name FROM information_schema.columns
 WHERE table_schema = 'v3' AND table_name = 'works' AND column_name = 'source_title';
