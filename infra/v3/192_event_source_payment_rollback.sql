-- =====================================================================
-- 192_event_source_payment_rollback.sql
--
--   192 を戻す。報告と入金の繋がり（どの入金の分か）は消える。報告そのものは残る。
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = v3, public;

DROP INDEX IF EXISTS v3.condition_events_source_payment_idx;
ALTER TABLE v3.condition_events DROP CONSTRAINT IF EXISTS condition_events_source_payment_fk;
ALTER TABLE v3.condition_events DROP COLUMN IF EXISTS source_payment_id;

COMMIT;
