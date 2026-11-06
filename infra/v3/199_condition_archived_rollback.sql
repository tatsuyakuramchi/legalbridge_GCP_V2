-- =====================================================================
-- 199_condition_archived_rollback.sql
--
--   199 を戻す。過去分で閉じた条件は「完了扱い」に戻る（閉じた日時・理由はそのまま）。
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = v3, public;

ALTER TABLE v3.conditions DROP CONSTRAINT IF EXISTS conditions_closed_kind_chk;
ALTER TABLE v3.conditions DROP COLUMN IF EXISTS closed_kind;

COMMIT;
