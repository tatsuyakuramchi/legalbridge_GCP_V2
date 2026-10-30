-- =====================================================================
-- 191_agreement_direction_none_rollback.sql
--
--   191 を戻す。向きの無い契約（direction が空）が残っていると戻せないので止まる。
--   先に画面で IN／OUT を選び直すか、次で一覧を見てから直すこと。
--     SELECT id, agreement_no, title FROM v3.agreements WHERE direction IS NULL;
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = v3, public;

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM v3.agreements WHERE direction IS NULL) THEN
    RAISE EXCEPTION '向きの無い契約が % 件あります。IN／OUT を選び直してから戻してください',
      (SELECT count(*) FROM v3.agreements WHERE direction IS NULL);
  END IF;
END
$guard$;

DROP TRIGGER IF EXISTS conditions_agreement_direction_biu ON v3.conditions;
DROP TRIGGER IF EXISTS agreements_direction_bu ON v3.agreements;
DROP FUNCTION IF EXISTS v3.check_condition_agreement_direction();
DROP FUNCTION IF EXISTS v3.check_agreement_direction_conditions();

ALTER TABLE v3.agreements DROP CONSTRAINT IF EXISTS agreements_direction_chk;
ALTER TABLE v3.agreements ALTER COLUMN direction SET NOT NULL;
ALTER TABLE v3.agreements ADD CONSTRAINT agreements_direction_check CHECK (direction IN ('in', 'out'));
COMMENT ON COLUMN v3.agreements.direction IS NULL;

COMMIT;
