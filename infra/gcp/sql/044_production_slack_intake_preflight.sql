\set ON_ERROR_STOP on
\pset pager off

-- 044_production_slack_intake_preflight.sql
-- 読取専用の事前確認（本番）。変更なし（適用は 044_production_slack_intake_grants.sql）。

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected production database legalbridge, connected to %', current_database();
  END IF;
END
$guard$;

-- 対象表の存在。
SELECT to_regclass('public.legal_requests') AS legal_requests,
       to_regclass('public.issue_workflows') AS issue_workflows,
       to_regclass('public.staff') AS staff,
       to_regclass('public.department_workflow_rules') AS department_workflow_rules;

-- legal_requests の AFTER INSERT トリガ（matter 自動生成・0103）。関数の SECURITY 属性も確認。
SELECT t.tgname, p.proname, CASE WHEN p.prosecdef THEN 'SECURITY DEFINER' ELSE 'INVOKER' END AS security
FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
WHERE t.tgrelid = 'public.legal_requests'::regclass AND NOT t.tgisinternal;

-- トリガが書く matters / matter_issues への現在の権限（INSERT が必要）。
SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privileges
FROM information_schema.role_table_grants
WHERE grantee = 'legalbridge_v2_runtime' AND table_schema = 'public'
  AND table_name IN ('matters', 'matter_issues', 'legal_requests', 'issue_workflows', 'staff', 'department_workflow_rules')
GROUP BY table_name ORDER BY table_name;

-- issue_workflows の一意制約（ON CONFLICT (backlog_issue_key) の前提）。
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.issue_workflows'::regclass AND contype IN ('p', 'u');

-- 参考: 直近の依頼レコード件数。
SELECT count(*) AS legal_requests_rows FROM public.legal_requests;
