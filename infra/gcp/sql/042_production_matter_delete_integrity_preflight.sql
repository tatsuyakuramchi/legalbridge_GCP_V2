\set ON_ERROR_STOP on
\pset pager off

-- 042_production_matter_delete_integrity_preflight.sql
-- 読取専用の事前確認（本番）。変更なし（適用は 042_production_matter_delete_integrity_grants.sql）。

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected production database legalbridge, connected to %', current_database();
  END IF;
END
$guard$;

-- V1 子表の存在確認（matter_slack_threads: 0145 / document_files: 0127）。
SELECT to_regclass('public.matter_slack_threads') AS matter_slack_threads,
       to_regclass('public.document_files') AS document_files,
       to_regclass('public.lb_v2_matter_slack_threads') AS lb_v2_matter_slack_threads;

-- 現在の対象表への権限。
SELECT table_name, privilege_type
FROM information_schema.role_table_grants
WHERE grantee = 'legalbridge_v2_runtime'
  AND table_schema = 'public'
  AND table_name IN ('matter_slack_threads', 'document_files', 'lb_v2_matter_slack_threads')
ORDER BY table_name, privilege_type;

-- 孤児化済みの V2 スレッド行（参照先 matters が無い）。042 適用で一掃される。
SELECT count(*) AS orphaned_v2_thread_rows
FROM public.lb_v2_matter_slack_threads t
WHERE NOT EXISTS (SELECT 1 FROM public.matters m WHERE m.id = t.matter_id);
