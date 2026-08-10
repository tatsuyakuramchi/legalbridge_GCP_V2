\set ON_ERROR_STOP on
\pset pager off

-- 038_production_contract_master_preflight.sql
-- 読取専用の事前確認（本番）。変更なし（GRANT は 038_production_contract_master_grants.sql）。

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected production database legalbridge, connected to %', current_database();
  END IF;
  IF to_regclass('public.contracts') IS NULL THEN
    RAISE EXCEPTION 'Relation public.contracts is missing';
  END IF;
END
$guard$;

-- 更新対象列の存在確認。
SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'contracts'
  AND column_name IN ('lifecycle_stage', 'contract_status', 'contract_title',
                      'effective_date', 'expiration_date', 'auto_renewal',
                      'renewal_notice_months', 'alert_lead_months', 'review_due_date')
ORDER BY column_name;

-- ライフサイクル別の件数（更新前の分布把握）。
SELECT COALESCE(lifecycle_stage, '(未設定)') AS lifecycle_stage, count(*) AS contracts
FROM public.contracts
GROUP BY lifecycle_stage
ORDER BY contracts DESC;

-- 現在の contracts への列 UPDATE 権限。
SELECT column_name, privilege_type
FROM information_schema.role_column_grants
WHERE grantee = 'legalbridge_v2_runtime'
  AND table_schema = 'public' AND table_name = 'contracts' AND privilege_type = 'UPDATE'
ORDER BY column_name;
