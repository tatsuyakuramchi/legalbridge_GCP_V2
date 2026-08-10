\set ON_ERROR_STOP on
\pset pager off

-- 034_production_document_reissue_preflight.sql
-- 読取専用の事前確認（本番）。変更なし（GRANT は 034_production_document_reissue_grants.sql）。

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected production database legalbridge, connected to %', current_database();
  END IF;
  IF to_regclass('public.documents') IS NULL THEN
    RAISE EXCEPTION 'Relation public.documents is missing';
  END IF;
END
$guard$;

-- 再発行に必要な列の存在確認。
SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND ((table_name = 'documents' AND column_name IN ('lifecycle_status', 'is_primary', 'superseded_by', 'base_document_number'))
    OR (table_name = 'condition_events' AND column_name IN ('voided_at', 'void_reason')))
ORDER BY table_name, column_name;

-- 現在の documents / condition_events の列レベル UPDATE 権限。
SELECT table_name, column_name, privilege_type
FROM information_schema.role_column_grants
WHERE grantee = 'legalbridge_v2_runtime'
  AND table_schema = 'public'
  AND table_name IN ('documents', 'condition_events')
  AND privilege_type = 'UPDATE'
ORDER BY table_name, column_name;

-- documents への表レベル INSERT（006）が付与済みか。
SELECT privilege_type
FROM information_schema.role_table_grants
WHERE grantee = 'legalbridge_v2_runtime'
  AND table_schema = 'public' AND table_name = 'documents'
ORDER BY privilege_type;
