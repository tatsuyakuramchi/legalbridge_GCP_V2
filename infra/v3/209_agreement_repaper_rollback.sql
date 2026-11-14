-- =====================================================================
-- 209_agreement_repaper_rollback.sql
--   契約の巻き直し（209）を外す。新旧のつながり（replaces_id）が消える。
--   契約そのもの・条件の載せ替え・旧契約の終了は戻らない（戻すなら契約の画面で直す）。
-- =====================================================================
\set ON_ERROR_STOP on
BEGIN;
DROP TRIGGER IF EXISTS agreements_repaper_aiu ON v3.agreements;
DROP FUNCTION IF EXISTS v3.agreements_repaper_trg();
DROP INDEX IF EXISTS v3.agreements_replaces_uq;
ALTER TABLE v3.agreements DROP COLUMN IF EXISTS replaces_id;
COMMIT;
