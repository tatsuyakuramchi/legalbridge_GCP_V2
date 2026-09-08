-- =====================================================================
-- LegalBridge V3 スキーマの後追い変更
--
--   001_schema.sql は CREATE TABLE IF NOT EXISTS で書いてあるので、
--   既に作られた表には流し直しても効かない。制約や列の変更はここに積む。
--   何度流しても同じ結果になるように書くこと。
--
--   実行: psql "$ADMIN_DSN" -f infra/v3/004_amend.sql
--   順番: 003_grants.sql の後、005_preflight.sql の前。
--   新しい表を足したときは 003_grants.sql も流し直すこと。
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;

SET LOCAL search_path = v3, public;

-- ---------------------------------------------------------------------
-- A-001 メールのスレッドを案件に紐づけられるようにする
--
--   受信したメールから案件を起こしたとき、同じスレッドの続きが届いても
--   案件を二重に立てないために、スレッドIDを控える先が要る。
--   制約名は自動採番なので、名前を決め打ちにせず pg_constraint から引く。
-- ---------------------------------------------------------------------
DO $amend_matter_links$
DECLARE
  con   text;
  wanted constant text[] := ARRAY[
    'backlog_issue', 'document', 'agreement', 'condition', 'payment',
    'slack_thread', 'email_thread'];
BEGIN
  -- 既に email_thread を通す制約なら何もしない。
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid = 'v3.matter_links'::regclass
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) LIKE '%email_thread%'
  ) THEN
    RAISE NOTICE 'A-001: 適用済み';
  ELSE
    SELECT c.conname INTO con
      FROM pg_constraint c
     WHERE c.conrelid = 'v3.matter_links'::regclass
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) LIKE '%target_type%'
     LIMIT 1;
    IF con IS NOT NULL THEN
      EXECUTE format('ALTER TABLE v3.matter_links DROP CONSTRAINT %I', con);
    END IF;
    EXECUTE format(
      'ALTER TABLE v3.matter_links ADD CONSTRAINT matter_links_target_type_check
         CHECK (target_type = ANY (%L::text[]))', wanted);
    RAISE NOTICE 'A-001: matter_links.target_type に email_thread を足した';
  END IF;
END
$amend_matter_links$;

COMMIT;

-- 確認
\echo '--- matter_links.target_type ---'
SELECT pg_get_constraintdef(c.oid) AS def
  FROM pg_constraint c
 WHERE c.conrelid = 'v3.matter_links'::regclass AND c.contype = 'c';
