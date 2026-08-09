\set ON_ERROR_STOP on
\pset pager off

-- 029_production_matter_delete_preflight.sql
-- 読取専用の事前確認（本番）。変更なし（GRANT は 029_production_matter_delete_grants.sql）。
-- 案件削除で連鎖・解除される FK 参照アクションを一覧し、想定外の CASCADE が無いか確認する。

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
END
$guard$;

-- matters を参照する FK と、その ON DELETE アクション（a=NO ACTION, r=RESTRICT, c=CASCADE, n=SET NULL, d=SET DEFAULT）。
SELECT
  con.conrelid::regclass AS referencing_table,
  att.attname           AS referencing_column,
  con.confdeltype       AS on_delete_action
FROM pg_constraint con
JOIN LATERAL unnest(con.conkey) AS k(attnum) ON true
JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum
WHERE con.contype = 'f'
  AND con.confrelid = 'public.matters'::regclass
ORDER BY referencing_table, referencing_column;

-- 現在の DELETE 権限（matters / matter_tasks に現れれば付与済み）。
SELECT
  table_name,
  string_agg(privilege_type, ', ' ORDER BY privilege_type) AS current_privileges
FROM information_schema.role_table_grants
WHERE grantee = 'legalbridge_v2_runtime'
  AND table_schema = 'public'
  AND table_name IN ('matters', 'matter_tasks')
GROUP BY table_name
ORDER BY table_name;
