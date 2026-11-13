-- =====================================================================
-- 208_agreement_versions_rollback.sql
--   契約の記録の版（208）を外す。履歴の表ごと消えるので、残したいときは先に書き出すこと。
--   契約の記録そのもの（v3.agreements）は変わらない。
-- =====================================================================
\set ON_ERROR_STOP on
BEGIN;
DROP TRIGGER IF EXISTS agreements_version_aiud ON v3.agreements;
DROP FUNCTION IF EXISTS v3.agreements_version_trg();
DROP TABLE IF EXISTS v3.agreement_versions;
COMMIT;
