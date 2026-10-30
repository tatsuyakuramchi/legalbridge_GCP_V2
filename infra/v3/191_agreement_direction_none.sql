-- =====================================================================
-- 191_agreement_direction_none.sql（Cloud Shell の psql / Cloud SQL Studio 用）
--
--   向き（IN／OUT）の無い契約を登録できるようにする。
--
--   NDA・覚書のように、お金の流れ（条件明細）を持たない「文書だけ」の契約は、
--   IN とも OUT とも言えない。これまでは agreements.direction が必須だったので、
--   どちらかを仮に選んで登録するしかなかった。
--     1. agreements.direction を空にできる。ただし空にできるのは kind = 'document'（文書だけ）のときだけ
--        （基本契約・単体契約・補助文書・解除合意は今までどおり IN／OUT が要る）
--     2. 向きの無い契約には条件明細を載せられない（条件は向きを持ち、契約と向きが揃う前提）
--        - conditions.agreement_id を向きの無い契約に向けると断る
--        - 条件明細の載った契約の向きを空にすると断る
--
--   何度流しても同じ結果。戻すときは 191_agreement_direction_none_rollback.sql。
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = v3, public;

-- 1. 向きの制約を張り替える ------------------------------------------------
--    001 の列制約（名前は自動で agreements_direction_check）を外し、文書だけなら空を許す制約にする。
ALTER TABLE v3.agreements ALTER COLUMN direction DROP NOT NULL;
DO $drop_direction_check$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'v3.agreements'::regclass AND contype = 'c'
       AND conname <> 'agreements_direction_chk'
       AND pg_get_constraintdef(oid) ~ '\mdirection\M'
  LOOP
    EXECUTE format('ALTER TABLE v3.agreements DROP CONSTRAINT %I', c.conname);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'v3.agreements'::regclass AND conname = 'agreements_direction_chk') THEN
    -- direction IN (...) は NULL のとき NULL（＝通る）になるので、CASE で空の場合を分ける。
    ALTER TABLE v3.agreements ADD CONSTRAINT agreements_direction_chk
      CHECK (CASE WHEN direction IS NULL THEN kind = 'document' ELSE direction IN ('in', 'out') END);
  END IF;
END
$drop_direction_check$;
COMMENT ON COLUMN v3.agreements.direction IS
  'in／out。文書だけ（kind = document：NDA・覚書など）は空にできる（向きなし）。向きなしの契約は条件明細を持たない。';

-- 2. 向きの無い契約に条件明細を載せない -------------------------------------
--    条件を契約に載せる書き手は多い（付け替え・寄せ・取り込み・文書の束）ので、アプリではなくここで担保する。
CREATE OR REPLACE FUNCTION v3.check_condition_agreement_direction() RETURNS trigger
LANGUAGE plpgsql AS $cond_dir$
BEGIN
  IF NEW.agreement_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM v3.agreements a WHERE a.id = NEW.agreement_id AND a.direction IS NULL) THEN
    RAISE EXCEPTION '向き（IN／OUT）の無い契約には条件明細を載せられません（契約 %）', NEW.agreement_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'conditions_agreement_direction_chk';
  END IF;
  RETURN NEW;
END
$cond_dir$;
DROP TRIGGER IF EXISTS conditions_agreement_direction_biu ON v3.conditions;
CREATE TRIGGER conditions_agreement_direction_biu BEFORE INSERT OR UPDATE OF agreement_id ON v3.conditions
  FOR EACH ROW EXECUTE FUNCTION v3.check_condition_agreement_direction();

CREATE OR REPLACE FUNCTION v3.check_agreement_direction_conditions() RETURNS trigger
LANGUAGE plpgsql AS $agr_dir$
BEGIN
  IF NEW.direction IS NULL AND OLD.direction IS NOT NULL
     AND EXISTS (SELECT 1 FROM v3.conditions c WHERE c.agreement_id = NEW.id) THEN
    RAISE EXCEPTION '条件明細の載った契約は向き（IN／OUT）を空にできません（契約 %）', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'agreements_direction_conditions_chk';
  END IF;
  RETURN NEW;
END
$agr_dir$;
DROP TRIGGER IF EXISTS agreements_direction_bu ON v3.agreements;
CREATE TRIGGER agreements_direction_bu BEFORE UPDATE OF direction ON v3.agreements
  FOR EACH ROW EXECUTE FUNCTION v3.check_agreement_direction_conditions();

COMMIT;

-- 確かめ：制約が張り替わり、トリガーが 2 本ある
SELECT conname, pg_get_constraintdef(oid) AS def
  FROM pg_constraint WHERE conrelid = 'v3.agreements'::regclass AND conname = 'agreements_direction_chk';
SELECT tgname FROM pg_trigger
 WHERE tgname IN ('conditions_agreement_direction_biu', 'agreements_direction_bu') AND NOT tgisinternal;
