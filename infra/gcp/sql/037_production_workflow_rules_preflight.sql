\set ON_ERROR_STOP on
\pset pager off

-- 037_production_workflow_rules_preflight.sql
-- 読取専用の事前確認（本番）。変更なし（GRANT は 037_production_workflow_rules_grants.sql）。

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected production database legalbridge, connected to %', current_database();
  END IF;
  IF to_regclass('public.department_workflow_rules') IS NULL THEN
    RAISE EXCEPTION 'Relation public.department_workflow_rules is missing';
  END IF;
END
$guard$;

-- 現在の承認ルート（部門別）。
SELECT department, approver_slack_id, stamp_operator_slack_id, manager_slack_id,
       slack_channel_id, COALESCE(is_active, true) AS is_active
FROM public.department_workflow_rules
ORDER BY department;

-- 現在の権限。
SELECT privilege_type
FROM information_schema.role_table_grants
WHERE grantee = 'legalbridge_v2_runtime'
  AND table_schema = 'public' AND table_name = 'department_workflow_rules'
ORDER BY privilege_type;
