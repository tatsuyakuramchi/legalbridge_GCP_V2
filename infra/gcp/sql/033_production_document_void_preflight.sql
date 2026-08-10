\set ON_ERROR_STOP on
\pset pager off

-- 033_production_document_void_preflight.sql
-- 読取専用の事前確認（本番）。変更なし（GRANT は 033_production_document_void_grants.sql）。

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
  IF to_regclass('public.condition_events') IS NULL THEN
    RAISE EXCEPTION 'Relation public.condition_events is missing';
  END IF;
END
$guard$;

-- void 対象となりうる必要列の存在確認。
SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND ((table_name = 'documents' AND column_name IN ('lifecycle_status', 'is_primary'))
    OR (table_name = 'condition_events' AND column_name IN ('voided_at', 'void_reason')))
ORDER BY table_name, column_name;

-- 現在の文書 lifecycle_status 内訳（void 済みの把握）。
SELECT lifecycle_status, count(*) AS documents
FROM public.documents
GROUP BY lifecycle_status
ORDER BY documents DESC;

-- 現在の列レベル UPDATE 権限（付与済みなら該当列が現れる）。
SELECT table_name, column_name, privilege_type
FROM information_schema.role_column_grants
WHERE grantee = 'legalbridge_v2_runtime'
  AND table_schema = 'public'
  AND table_name IN ('documents', 'condition_events')
  AND privilege_type = 'UPDATE'
ORDER BY table_name, column_name;
