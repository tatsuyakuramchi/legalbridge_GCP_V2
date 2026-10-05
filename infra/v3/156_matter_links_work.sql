-- =====================================================================
-- 156 案件に作品を複数つなげる（matter_links.target_type に 'work' を足す）
--
--   ライセンスの取引は、1つの案件で複数の作品を扱うことがある（例：同じ作家の
--   3作品をまとめて権利取得）。これまで案件は作品を 1 つ（matters.work_id）しか
--   持てなかった。
--
--   ・最初の作品はこれまでどおり matters.work_id に入れる（既存の画面はそのまま）。
--   ・2つ目以降の作品は matter_links に target_type = 'work'（target_ref = 作品 id）で持つ。
--     案件は参照するだけで所有しない（条件・作品・取引先は案件より寿命が長い）という
--     matter_links の決まりに合う。
--
--   流す順番：この SQL を先に流してからアプリを出す。アプリが先だと、作品を 2 つ以上
--   選んで案件を立てたときに制約で断られる（1 つなら今までどおり通る）。
--
--   何度流しても同じ（'work' が既に入っていれば何もしない）。
--   実行: psql -v ON_ERROR_STOP=1 -f infra/v3/156_matter_links_work.sql
--         （Cloud SQL Studio にそのまま貼ってもよい）
-- =====================================================================

BEGIN;

DO $do$
DECLARE
  con text;
  wanted constant text[] := ARRAY[
    'backlog_issue', 'document', 'agreement', 'condition', 'payment',
    'slack_thread', 'email_thread', 'work'];
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid = 'v3.matter_links'::regclass
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) ~ '\mwork\M'
  ) THEN
    RAISE NOTICE '156: matter_links は既に作品を通します。何もしません';
    RETURN;
  END IF;
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
  RAISE NOTICE '156: matter_links.target_type に work を足した';
END
$do$;

COMMIT;

-- 確認（制約に work が入っている）
SELECT c.conname AS 制約, pg_get_constraintdef(c.oid) AS 定義
  FROM pg_constraint c
 WHERE c.conrelid = 'v3.matter_links'::regclass AND c.contype = 'c';
