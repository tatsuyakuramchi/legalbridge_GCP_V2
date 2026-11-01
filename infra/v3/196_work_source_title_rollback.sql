-- =====================================================================
-- 196_work_source_title_rollback.sql
--
--   196 を戻す。作品の原作名は消える（計算書の件名は、系譜の原作名か作品名に戻る）。
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = v3, public;

ALTER TABLE v3.works DROP COLUMN IF EXISTS source_title;

COMMIT;
