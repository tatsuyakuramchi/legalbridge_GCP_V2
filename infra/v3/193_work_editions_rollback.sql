-- =====================================================================
-- 193_work_editions_rollback.sql
--
--   193 を戻す。刊行物（版元・ISBN・刊行日・本体価格）は消える。作品・条件はそのまま残る。
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = v3, public;

DROP TABLE IF EXISTS v3.work_editions;

COMMIT;
