\set ON_ERROR_STOP on
\pset pager off

-- 026_production_matter_document_links_preflight.sql
-- 読取専用の事前確認（本番）。変更なし（GRANT は 026_production_matter_document_links_grants.sql）。

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

-- 列レベル UPDATE(matter_id) が付与されているか（column_grants を確認）。
SELECT table_name, column_name, privilege_type
FROM information_schema.role_column_grants
WHERE grantee = 'legalbridge_v2_runtime'
  AND table_schema = 'public'
  AND table_name = 'documents'
  AND column_name = 'matter_id'
ORDER BY privilege_type;
