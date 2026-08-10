\set ON_ERROR_STOP on
\pset pager off

-- 042_production_matter_delete_integrity_grants.sql
-- 案件削除の整合（S-E・監査 P0-10）：
--   1. 影響プレビューの件数表示に必要な SELECT を付与
--      （V1 の子表 matter_slack_threads / document_files。削除確認画面の過少申告を解消）。
--   2. lb_v2_matter_slack_threads への DELETE を付与
--      （本表は「1案件=1スレッド」のポインタ表であり監査台帳ではない。V1 の同等表
--        matter_slack_threads は matters への FK ON DELETE CASCADE を持つが、lb_v2 側は
--        FK を持たないため、案件削除トランザクション内の明示 DELETE で整合を取る）。
--   3. 既に孤児化した lb_v2_matter_slack_threads 行（参照先 matters が無い）を一掃
--      （放置すると matter_id 再利用時に UNIQUE(matter_id) がスレッド作成を恒久ブロック）。

\if :{?confirm_matter_delete_integrity}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_matter_delete_integrity=GRANT_PRODUCTION_MATTER_DELETE_INTEGRITY'
  \quit 2
\endif

SELECT :'confirm_matter_delete_integrity' = 'GRANT_PRODUCTION_MATTER_DELETE_INTEGRITY' AS confirmed
\gset

\if :confirmed
\else
  \echo 'Confirmation value is invalid; no changes were made.'
  \quit 2
\endif

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected production database legalbridge, connected to %', current_database();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legalbridge_v2_runtime') THEN
    RAISE EXCEPTION 'Role legalbridge_v2_runtime does not exist';
  END IF;
  IF to_regclass('public.lb_v2_matter_slack_threads') IS NULL THEN
    RAISE EXCEPTION 'Required relation public.lb_v2_matter_slack_threads is missing (apply 024 first)';
  END IF;
  IF to_regclass('public.matters') IS NULL THEN
    RAISE EXCEPTION 'Required relation public.matters is missing';
  END IF;
END
$guard$;

GRANT CONNECT ON DATABASE legalbridge TO legalbridge_v2_runtime;
GRANT USAGE ON SCHEMA public TO legalbridge_v2_runtime;

-- 1. 影響プレビュー用の SELECT（V1 子表・存在するものだけ）。
DO $selects$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['matter_slack_threads', 'document_files'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON TABLE public.%I TO legalbridge_v2_runtime', t);
    ELSE
      RAISE NOTICE 'Skipping SELECT grant: public.% does not exist', t;
    END IF;
  END LOOP;
END
$selects$;

-- 2. V2 スレッドポインタ表の行削除（案件削除との整合用）。UPDATE/TRUNCATE は付与しない。
GRANT DELETE ON TABLE public.lb_v2_matter_slack_threads TO legalbridge_v2_runtime;

-- 3. 既存孤児の一掃（一回限り・冪等）。
WITH removed AS (
  DELETE FROM public.lb_v2_matter_slack_threads t
   WHERE NOT EXISTS (SELECT 1 FROM public.matters m WHERE m.id = t.matter_id)
  RETURNING t.matter_id
)
SELECT count(*) AS orphaned_thread_rows_removed FROM removed;

-- 事後検証：DELETE 付与が無ければトランザクションごと失敗させる。
DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
     WHERE grantee = 'legalbridge_v2_runtime'
       AND table_schema = 'public' AND table_name = 'lb_v2_matter_slack_threads'
       AND privilege_type = 'DELETE'
  ) THEN
    RAISE EXCEPTION 'lb_v2_matter_slack_threads DELETE grant was not applied';
  END IF;
END
$verify$;

COMMIT;
