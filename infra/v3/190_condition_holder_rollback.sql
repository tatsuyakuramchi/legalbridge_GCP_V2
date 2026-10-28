-- =====================================================================
-- 190_condition_holder_rollback.sql
--
--   190 を戻す。190 を流した直後に使うもの（流したあとに画面で条件や契約を動かしていると、
--   その分も移行前の値に戻る）。
--     1. 190 が器に繋いだ発注書を、器から外す
--     2. 条件の agreement_id を退避（v3.condition_holder_190_backup）の値に戻す
--     3. 190 が立てた器（v3.condition_holder_190_created）を消す
--   退避・記録の表は残す（もう一度 190 を流せる）。
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = v3, public;

UPDATE v3.documents d SET agreement_id = NULL
  FROM v3.condition_holder_190_created k
 WHERE d.id = k.document_id AND d.agreement_id = k.agreement_id;

UPDATE v3.conditions c SET agreement_id = b.agreement_id, updated_at = now()
  FROM v3.condition_holder_190_backup b
 WHERE c.id = b.condition_id AND c.agreement_id IS DISTINCT FROM b.agreement_id;

DELETE FROM v3.agreements a USING v3.condition_holder_190_created k WHERE a.id = k.agreement_id;
DELETE FROM v3.condition_holder_190_created;

SELECT '基本契約を直接指す条件' AS what, count(*)
  FROM v3.conditions c JOIN v3.agreements a ON a.id = c.agreement_id
 WHERE COALESCE(a.kind, 'master') = 'master';

COMMIT;
