-- =====================================================================
-- 194_work_editions_oem_rollback.sql
--
--   194 を戻す。他社販売（oem）の製品は消せないので、関係を再許諾に読み替えて根拠の条件を外す
--   （条件の点検の「版元の条件なし」に出る）。刊行物・製品そのものは残る。
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = v3, public;

UPDATE v3.work_editions SET relation = 'sublicense', out_condition_id = NULL, updated_at = now() WHERE relation = 'oem';
ALTER TABLE v3.work_editions DROP CONSTRAINT IF EXISTS work_editions_relation_check;
ALTER TABLE v3.work_editions ADD CONSTRAINT work_editions_relation_check
  CHECK (relation IN ('own', 'group', 'sublicense'));

COMMIT;
