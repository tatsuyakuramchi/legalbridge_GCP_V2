\set ON_ERROR_STOP on
\pset pager off

-- 008_production_matter_management_preflight.sql
-- 読取専用の事前確認。変更は一切行わない（GRANT は 008_..._grants.sql 側）。
--   ① 本番 legalbridge へ接続していること
--   ② legalbridge_v2_runtime ロールが存在すること
--   ③ matters / matter_tasks と対応 sequence が存在すること
--   ④ 現状の runtime 権限（SELECT の有無、INSERT/UPDATE 未付与）を表示

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected production database legalbridge, connected to %', current_database();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legalbridge_v2_runtime') THEN
    RAISE EXCEPTION 'Role legalbridge_v2_runtime does not exist';
  END IF;
  IF to_regclass('public.matters') IS NULL THEN
    RAISE EXCEPTION 'Relation public.matters is missing';
  END IF;
  IF to_regclass('public.matter_tasks') IS NULL THEN
    RAISE EXCEPTION 'Relation public.matter_tasks is missing';
  END IF;
  IF to_regclass('public.matters_id_seq') IS NULL THEN
    RAISE EXCEPTION 'Sequence public.matters_id_seq is missing';
  END IF;
  IF to_regclass('public.matter_tasks_id_seq') IS NULL THEN
    RAISE EXCEPTION 'Sequence public.matter_tasks_id_seq is missing';
  END IF;
END
$guard$;

-- 付与予定テーブルの現状権限（この preflight 実行前は INSERT/UPDATE が無いはず）。
SELECT
  table_name,
  string_agg(privilege_type, ', ' ORDER BY privilege_type) AS current_privileges
FROM information_schema.role_table_grants
WHERE grantee = 'legalbridge_v2_runtime'
  AND table_schema = 'public'
  AND table_name IN ('matters', 'matter_tasks')
GROUP BY table_name
ORDER BY table_name;
