\set ON_ERROR_STOP on
\pset pager off

-- 031_production_contract_expiry_preflight.sql
-- 読取専用の事前確認（本番）。変更なし（GRANT は 031_production_contract_expiry_grants.sql）。

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected production database legalbridge, connected to %', current_database();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legalbridge_v2_runtime') THEN
    RAISE EXCEPTION 'Role legalbridge_v2_runtime does not exist';
  END IF;
  IF to_regclass('public.documents') IS NULL THEN
    RAISE EXCEPTION 'Relation public.documents is missing';
  END IF;
END
$guard$;

-- 遷移対象の見込み件数（満了日超過かつ draft/awaiting_signature/executed）。適用前の影響確認。
SELECT count(*) AS pending_expiry_transitions
FROM public.documents
WHERE expiration_date IS NOT NULL
  AND expiration_date < CURRENT_DATE
  AND contract_status IN ('draft', 'awaiting_signature', 'executed');

-- 現在の列レベル UPDATE 権限（contract_status が現れれば付与済み）。
SELECT table_name, column_name, privilege_type
FROM information_schema.role_column_grants
WHERE grantee = 'legalbridge_v2_runtime'
  AND table_schema = 'public'
  AND table_name = 'documents'
ORDER BY column_name, privilege_type;
